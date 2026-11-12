from __future__ import annotations

import uuid
from typing import Final

import structlog

from iclip.common.errors import NotFound
from iclip.domains.conversations.models import (
    CheckedWholeFilm,
    WholeFilmExport,
    WholeFilmExportError,
    WholeFilmExportStatus,
)
from iclip.domains.conversations.service import WholeFilmRenderUnavailable
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
    KIND_WHOLE_FILM,
    WholeFilmRequest,
    WholeFilmVideoSource,
)
from iclip.domains.generation.service import GenerationService
from iclip.domains.identity.public import Principal

_logger = structlog.stdlib.get_logger(__name__)

_NOT_THIS_EXPORT: Final = "没有这次导出"


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
        revision: int,
        film: CheckedWholeFilm,
    ) -> uuid.UUID:
        request = WholeFilmRequest(
            revision=revision,
            videos=[
                WholeFilmVideoSource(job_id=source.job_id, url=source.url)
                for source in film.sources
            ],
            music=None,
        )
        job = await self._generation.submit_whole_film(
            principal, conversation_id=conversation_id, request=request
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
            raise WholeFilmRenderUnavailable(str(exc)) from exc

    async def _export_of(self, job: GenerationJob) -> WholeFilmExport:
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


__all__ = ["WholeFilmExportAdapter"]
