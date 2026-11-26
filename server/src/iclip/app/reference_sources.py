from __future__ import annotations

import uuid
from collections.abc import Callable

import structlog

from iclip.common.errors import NotFound
from iclip.domains.generation.models import GenerationJob, is_base_master
from iclip.domains.generation.repository import GenerationRepository
from iclip.domains.generation.schemas import KIND_AUDIO, OPERATION_GENERATE, STATUS_COMPLETED
from iclip.domains.identity.public import Principal, visible_owner_incl_act_as
from iclip.domains.references.models import (
    KIND_VIDEO,
    PEAK_BUCKETS,
    MeasuredAudio,
    ReferenceKind,
)
from iclip.domains.uploads.service import UploadService
from iclip.platform.media.errors import MediaError
from iclip.platform.media.probe import measure_remote_audio

_logger = structlog.stdlib.get_logger(__name__)


class ReferenceMediaSources:
    """参考资产的 ``MediaSources`` 接到上传台账与生成记录上。"""

    def __init__(self, uploads: UploadService | None, generations: GenerationRepository) -> None:
        self._uploads = uploads
        self._generations = generations

    async def upload_url(
        self, principal: Principal, upload_id: uuid.UUID, *, kind: ReferenceKind
    ) -> str | None:
        if self._uploads is None:
            raise RuntimeError("没有对象存储时参考资产不收上传，不该来查上传")
        return await self._uploads.own_upload(principal, upload_id, kind=kind)

    async def generation_url(
        self, principal: Principal, job_id: uuid.UUID, *, kind: ReferenceKind
    ) -> str | None:
        try:
            job = await self._generations.get(job_id, owner=visible_owner_incl_act_as(principal))
        except NotFound:
            return None
        usable = is_base_master(job) if kind == KIND_VIDEO else _finished_music(job)
        return job.output.url if usable else None


def _finished_music(job: GenerationJob) -> bool:
    return (
        job.kind == KIND_AUDIO
        and job.operation == OPERATION_GENERATE
        and job.status == STATUS_COMPLETED
        and job.output.url is not None
    )


class ProbedAudio:
    """参考音频的 ``AudioMeasure``：用 ffmpeg 按地址解码一遍，量时长与波形峰值；量不出来记一条警告、
    答 None。"""

    def __init__(self, fetch_url: Callable[[str], str]) -> None:
        self._fetch_url = fetch_url

    async def __call__(self, url: str, /) -> MeasuredAudio | None:
        try:
            levels = await measure_remote_audio(self._fetch_url(url), buckets=PEAK_BUCKETS)
        except MediaError as exc:
            _logger.warning("量不出参考音频的时长与波形", error=str(exc))
            return None
        return MeasuredAudio(duration_ms=levels.duration_ms, peaks=levels.peaks)


__all__ = ["ProbedAudio", "ReferenceMediaSources"]
