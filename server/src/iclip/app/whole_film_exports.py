from __future__ import annotations

import uuid
from collections.abc import Sequence
from typing import Final

import structlog

from iclip.app.runtime_workspace import WorkspaceFiles
from iclip.common.errors import NotFound
from iclip.common.final_cut import PROJECT_DIR, TargetLocale, media_addresses
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
)
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
from iclip.platform.runtime_api.client import RuntimeUnavailable
from iclip.platform.runtime_api.file_store.namespace import namespace_for

_logger = structlog.stdlib.get_logger(__name__)

_NOT_THIS_EXPORT: Final = "没有这次导出"

_PROJECT_PREFIX: Final = f"{PROJECT_DIR}/"


def final_cut_reader(store: WorkspaceFiles) -> ReadProject:
    """交给渲染服务时读工程：列出工作区 ``final-cut/`` 下的全部文件逐个读出，路径去掉这个前缀。"""

    async def read_project(owner: uuid.UUID, conversation_id: uuid.UUID) -> Sequence[ProjectFile]:
        namespace = namespace_for(owner, str(conversation_id))
        files: list[ProjectFile] = []
        try:
            for entry in await store.entries(namespace, prefix=PROJECT_DIR):
                if not entry.path.startswith(_PROJECT_PREFIX):
                    continue
                stored = await store.read(namespace, entry.path)
                # 列出之后又删掉的文件不算在这一刻的工程里
                if stored is not None:
                    files.append(
                        ProjectFile(
                            path=entry.path.removeprefix(_PROJECT_PREFIX), content=stored.content
                        )
                    )
        except RuntimeUnavailable as exc:
            raise ProjectUnavailable("读不到对话工作区里的 final-cut，稍后再试") from exc
        return files

    return read_project


class WholeFilmExportAdapter:
    def __init__(
        self,
        *,
        generation: GenerationService,
        generations: GenerationRepository,
        render: RenderClient,
    ) -> None:
        self._generation = generation
        self._generations = generations
        self._render = render

    async def start(
        self,
        principal: Principal,
        *,
        conversation_id: uuid.UUID,
        main_file: str,
        locale: TargetLocale | None,
    ) -> uuid.UUID:
        """记一条成片记录排队：主文件里的素材按输出地址对上生成记录的记进去，对不上的不记；
        导出哪种语言（``locale``，None 是原文）也记进去。"""

        addresses = media_addresses(main_file)
        records = await self._generations.earliest_by_outputs(
            [address.url for address in addresses]
        )
        videos: list[WholeFilmVideoSource] = []
        audios: list[WholeFilmAudioSource] = []
        for address in addresses:
            record = records.get(address.url)
            if record is None:
                continue
            if address.kind == "video":
                videos.append(WholeFilmVideoSource(job_id=record.id, url=address.url))
            else:
                audios.append(WholeFilmAudioSource(job_id=record.id, url=address.url))
        job = await self._generation.submit_whole_film(
            principal,
            conversation_id=conversation_id,
            request=WholeFilmRequest(videos=videos, audios=audios, locale=locale),
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
            raise RuntimeError(f"成片记录 {job.id} 没有成片导出的请求")
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
                raise RuntimeError(f"成片记录 {job.id} 失败了却没有错误码与原因")
            if job.error_code == CANCELLED:
                status = "cancelled"
            else:
                status = "failed"
                error = WholeFilmExportError(code=job.error_code, message=job.error_message)
        return WholeFilmExport(
            id=job.id,
            locale=request.locale,
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
            _logger.warning("读导出进度时渲染服务连不上", job_id=job.id)
            return None
        if found is None:
            _logger.warning("渲染服务里查不到这次导出", job_id=job.id)
        return found


def _recorded_stage(provider_status: str | None) -> RenderStage:
    for stage in RENDER_STAGES:
        if stage == provider_status:
            return stage
    return "queued"


__all__ = ["WholeFilmExportAdapter", "final_cut_reader"]
