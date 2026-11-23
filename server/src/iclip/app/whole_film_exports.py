from __future__ import annotations

import uuid
from collections.abc import Sequence
from typing import Final

import structlog

from iclip.app.runtime_workspace import WorkspaceFiles
from iclip.common.errors import NotFound
from iclip.common.final_cut import PROJECT_DIR, ExportResolution, TargetLocale, media_addresses
from iclip.domains.conversations.models import (
    WholeFilmExport,
    WholeFilmExportError,
    WholeFilmExportStatus,
)
from iclip.domains.conversations.service import FinalCutRenderUnavailable
from iclip.domains.generation.models import (
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_SUBMITTED,
    GenerationJob,
    inherited_through,
)
from iclip.domains.generation.ports import ConversationLineage
from iclip.domains.generation.render import (
    CANCELLED,
    RENDER_STAGES,
    ProjectFile,
    ProjectUnavailable,
    ReadProject,
    RenderClient,
    RenderExport,
    RenderStage,
    RenderUnavailable,
)
from iclip.domains.generation.repository import GenerationRepository
from iclip.domains.generation.schemas import (
    KIND_WHOLE_FILM,
    WholeFilmAudioSource,
    WholeFilmRequest,
    WholeFilmVideoSource,
)
from iclip.domains.generation.service import GenerationService
from iclip.domains.identity.public import Principal
from iclip.domains.references.infra_sql import SqlReferenceLookup
from iclip.domains.uploads.service import UploadService
from iclip.platform.runtime_api.client import RuntimeUnavailable
from iclip.platform.runtime_api.file_store.namespace import namespace_for

_logger = structlog.stdlib.get_logger(__name__)

_NOT_THIS_EXPORT: Final = "导出记录不存在"

_PROJECT_PREFIX: Final = f"{PROJECT_DIR}/"


def final_cut_reader(store: WorkspaceFiles) -> ReadProject:
    """提交至渲染服务前读取工程：遍历并读取工作区 ``final-cut/`` 下的全部文件，返回相对工程根目录的路径。"""

    async def read_project(owner: uuid.UUID, conversation_id: uuid.UUID) -> Sequence[ProjectFile]:
        namespace = namespace_for(owner, str(conversation_id))
        files: list[ProjectFile] = []
        try:
            for entry in await store.entries(namespace, prefix=PROJECT_DIR):
                if not entry.path.startswith(_PROJECT_PREFIX):
                    continue
                stored = await store.read(namespace, entry.path)
                # 列举后已被删除的文件不纳入当前工程快照
                if stored is not None:
                    files.append(
                        ProjectFile(
                            path=entry.path.removeprefix(_PROJECT_PREFIX), content=stored.content
                        )
                    )
        except RuntimeUnavailable as exc:
            raise ProjectUnavailable("无法读取对话工作区中的 final-cut 工程，请稍后重试") from exc
        return files

    return read_project


class WholeFilmExportAdapter:
    def __init__(
        self,
        *,
        generation: GenerationService,
        generations: GenerationRepository,
        uploads: UploadService,
        references: SqlReferenceLookup,
        lineage: ConversationLineage,
        render: RenderClient,
    ) -> None:
        self._generation = generation
        self._generations = generations
        self._uploads = uploads
        self._references = references
        self._lineage = lineage
        self._render = render

    async def start(
        self,
        principal: Principal,
        *,
        conversation_id: uuid.UUID,
        main_file: str,
        locale: TargetLocale | None,
        resolution: ExportResolution | None,
    ) -> uuid.UUID:
        """创建成片导出记录并入队，同步记录目标语言（``locale``，``None`` 表示原文）与导出分辨率档位
        （``resolution``，``None`` 表示按画面尺寸导出）。主文件中的素材按地址匹配来源，未命中者忽略：
        ``<video>`` 匹配生成记录；``<audio>`` 依次匹配本对话（含分叉继承）的生成记录、本对话（含分叉
        继承）的上传记录及参考音频库，命中即止。"""

        addresses = media_addresses(main_file)
        records = await self._generations.earliest_by_outputs(
            [address.url for address in addresses]
        )
        inheritance = await self._lineage.ancestry(conversation_id)
        audio_urls = [address.url for address in addresses if address.kind != "video"]
        uploads = await self._uploads.conversation_uploads_at(conversation_id, audio_urls)
        references = await self._references.audio_ids_at(audio_urls)
        videos: list[WholeFilmVideoSource] = []
        audios: list[WholeFilmAudioSource] = []
        for address in addresses:
            record = records.get(address.url)
            if address.kind == "video":
                if record is not None:
                    videos.append(WholeFilmVideoSource(job_id=record.id, url=address.url))
                continue
            if record is not None and (
                record.conversation_id == conversation_id or inherited_through(record, inheritance)
            ):
                audios.append(
                    WholeFilmAudioSource(
                        source_kind="generation", source_id=record.id, url=address.url
                    )
                )
                continue
            upload = uploads.get(address.url)
            if upload is not None:
                audios.append(
                    WholeFilmAudioSource(source_kind="upload", source_id=upload.id, url=address.url)
                )
                continue
            reference_id = references.get(address.url)
            if reference_id is not None:
                audios.append(
                    WholeFilmAudioSource(
                        source_kind="reference", source_id=reference_id, url=address.url
                    )
                )
        job = await self._generation.submit_whole_film(
            principal,
            conversation_id=conversation_id,
            request=WholeFilmRequest(
                videos=videos, audios=audios, locale=locale, resolution=resolution
            ),
        )
        return job.id

    async def latest(
        self, *, conversation_id: uuid.UUID, owner_user_id: uuid.UUID
    ) -> WholeFilmExport | None:
        records = await self._generations.list_for_owner(
            owner=owner_user_id, limit=1, conversation_id=conversation_id, kind=KIND_WHOLE_FILM
        )
        if not records:
            return None
        (job,) = records
        return await self._export_of(job)

    async def cancel(
        self, *, conversation_id: uuid.UUID, owner_user_id: uuid.UUID, export_id: uuid.UUID
    ) -> None:
        try:
            job = await self._generations.get(export_id, owner=owner_user_id)
        except NotFound:
            raise NotFound(_NOT_THIS_EXPORT) from None
        if job.kind != KIND_WHOLE_FILM or job.conversation_id != conversation_id:
            raise NotFound(_NOT_THIS_EXPORT)
        try:
            await self._generation.cancel_whole_film(job)
        except RenderUnavailable as exc:
            raise FinalCutRenderUnavailable(str(exc)) from exc

    async def _export_of(self, job: GenerationJob) -> WholeFilmExport:
        request = job.request
        if not isinstance(request, WholeFilmRequest):
            raise RuntimeError(f"成片导出记录 {job.id} 缺少有效的 WholeFilmRequest 请求体")
        status: WholeFilmExportStatus = "queued"
        progress: float | None = None
        queue_position: int | None = None
        error: WholeFilmExportError | None = None
        if job.status == STATUS_SUBMITTED:
            live = await self._live(job)
            if live is not None and live.status in RENDER_STAGES:
                status = live.status
                progress, queue_position = live.progress, live.queue_position
            else:
                status = _recorded_stage(job.provider_status)
        elif job.status == STATUS_COMPLETED:
            status = "done"
        elif job.status == STATUS_FAILED:
            if job.error_code is None or job.error_message is None:
                raise RuntimeError(f"成片导出记录 {job.id} 状态为失败，但缺少错误码或错误说明")
            if job.error_code == CANCELLED:
                status = "cancelled"
            else:
                status = "failed"
                error = WholeFilmExportError(code=job.error_code, message=job.error_message)
        return WholeFilmExport(
            id=job.id,
            locale=request.locale,
            resolution=request.resolution,
            status=status,
            progress=progress,
            queue_position=queue_position,
            error=error,
            download_url=job.output.url if status == "done" else None,
        )

    async def _live(self, job: GenerationJob) -> RenderExport | None:
        try:
            found = await self._render.get(job.id)
        except RenderUnavailable:
            _logger.warning("查询导出进度时渲染服务不可达", job_id=job.id)
            return None
        if found is None:
            _logger.warning("渲染服务中未找到该导出任务", job_id=job.id)
        return found


def _recorded_stage(provider_status: str | None) -> RenderStage:
    for stage in RENDER_STAGES:
        if stage == provider_status:
            return stage
    return "queued"


__all__ = ["WholeFilmExportAdapter", "final_cut_reader"]
