"""整片导出的组合根适配：把草稿换成一条整片生成记录的请求，读最新一次导出，取消。

每次导出是一条整片生成记录，由生成队列交给渲染服务（见 ``generation/render.py``）；这里只在记录
已交给渲染服务时转问它的排队位置与进度。"""

from __future__ import annotations

import uuid
from typing import Final

import structlog

from iclip.common.errors import NotFound, ValidationFailed
from iclip.domains.conversations.models import (
    WholeFilmExport,
    WholeFilmExportError,
    WholeFilmExportStatus,
)
from iclip.domains.conversations.service import WholeFilmRenderUnavailable
from iclip.domains.conversations.whole_film_schemas import WholeFilmDocument
from iclip.domains.generation.models import (
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_SUBMITTED,
    GenerationJob,
)
from iclip.domains.generation.render import (
    CANCELLED,
    RENDER_STAGES,
    RenderClient,
    RenderExport,
    RenderStage,
    RenderUnavailable,
)
from iclip.domains.generation.repository import GenerationRepository
from iclip.domains.generation.schemas import (
    KIND_SUBTITLE,
    KIND_WHOLE_FILM,
    WholeFilmMusicSource,
    WholeFilmRequest,
    WholeFilmSubtitles,
    WholeFilmVideoSource,
)
from iclip.domains.generation.service import GenerationService
from iclip.domains.identity.public import Principal

_logger = structlog.stdlib.get_logger(__name__)

SUBTITLE_SCAN_LIMIT: Final = 50
"""每条成片往回看几条字幕记录找最新的已完成那条；手动重识别不会多到这个数。"""

_NOT_THIS_EXPORT: Final = "没有这次导出"


class WholeFilmExportAdapter:
    """对话域 ``WholeFilmExports`` 的实现。"""

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
        revision: int,
        document: WholeFilmDocument,
    ) -> uuid.UUID:
        sources = document.video_sources()
        music_id = None if document.music is None else document.music.job_id
        wanted = (*sources, *(() if music_id is None else (music_id,)))
        urls = await self._generations.output_urls(set(wanted))
        for job_id in wanted:
            if job_id not in urls:
                raise ValidationFailed(f"记录 {job_id} 没有产物地址，导不出整片")
        request = WholeFilmRequest(
            revision=revision,
            document=document.model_dump(mode="json", by_alias=True),
            videos=[WholeFilmVideoSource(job_id=source, url=urls[source]) for source in sources],
            music=None
            if music_id is None
            else WholeFilmMusicSource(job_id=music_id, url=urls[music_id]),
            subtitles=await self._subtitles(sources),
        )
        job = await self._generation.submit_whole_film(
            principal, conversation_id=conversation_id, request=request
        )
        return job.id

    async def _subtitles(self, sources: tuple[uuid.UUID, ...]) -> list[WholeFilmSubtitles]:
        """每条成片最新的一条已完成字幕记录（含逐词时间）；一条都没有的成片不在里面。

        不看属主：出处已在存草稿时核过是这段对话读得到的成片，它的字幕跟着读。"""

        found: list[WholeFilmSubtitles] = []
        for source in sources:
            records = await self._generations.list_for_owner(
                owner=None, limit=SUBTITLE_SCAN_LIMIT, kind=KIND_SUBTITLE, source_job_id=source
            )
            latest = next(
                (
                    record
                    for record in records
                    if record.status == STATUS_COMPLETED and record.sentences is not None
                ),
                None,
            )
            if latest is not None and latest.sentences is not None:
                found.append(
                    WholeFilmSubtitles(
                        source_job_id=source, subtitle_job_id=latest.id, sentences=latest.sentences
                    )
                )
        return found

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
            raise WholeFilmRenderUnavailable(str(exc)) from exc

    async def _export_of(self, job: GenerationJob) -> WholeFilmExport:
        """记录给人看的样子：已交给渲染服务的转问它走到哪一步，其余只看记录。"""

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
                # 渲染服务答不上来，或它已结束、轮询还没记下：按记录上最后一次记下的那一步。
                status = _recorded_stage(job.provider_status)
        elif job.status == STATUS_COMPLETED:
            status = "done"
        elif job.status == STATUS_FAILED:
            if job.error_code is None or job.error_message is None:
                raise RuntimeError(f"整片记录 {job.id} 失败了却没有错误码与原因")
            if job.error_code == CANCELLED:
                status = "cancelled"
            else:
                status = "failed"
                error = WholeFilmExportError(code=job.error_code, message=job.error_message)
        return WholeFilmExport(
            id=job.id,
            status=status,
            progress=progress,
            queue_position=queue_position,
            error=error,
            download_url=job.output_url if status == "done" else None,
            source_job_ids=_source_job_ids(job),
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
    """记录上最后一次记下的那一步；还没记过（刚交出去）就是排队。"""

    for stage in RENDER_STAGES:
        if stage == provider_status:
            return stage
    return "queued"


def _source_job_ids(job: GenerationJob) -> tuple[uuid.UUID, ...]:
    if not isinstance(job.request, WholeFilmRequest):
        raise RuntimeError(f"整片记录 {job.id} 的请求不是整片导出的形状")
    return tuple(video.job_id for video in job.request.videos)


__all__ = ["SUBTITLE_SCAN_LIMIT", "WholeFilmExportAdapter"]
