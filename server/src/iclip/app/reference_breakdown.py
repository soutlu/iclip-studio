from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable

from agent_runtime.client import RuntimeClient
from iclip_video.video_breakdown.ports import FailedBreakdown

from iclip.domains.identity.public import Principal
from iclip.domains.references.models import (
    ERROR_MODEL_CALL_FAILED,
    ERROR_MODEL_FAILED,
    ERROR_MODEL_UNAVAILABLE,
    ERROR_VIDEO_UNREADABLE,
    BreakdownFailed,
)
from iclip.domains.references.service import ReferenceService
from iclip.platform.media.codec import MediaCodec
from iclip.platform.media.errors import MediaError
from iclip.platform.media.fetch import MediaDownloads
from iclip.platform.video_breakdown.media import FfmpegVideoSampler
from iclip.platform.video_breakdown.model import BREAKDOWN_MODEL, ArkBreakdownModel
from iclip.platform.video_breakdown.ports import BreakdownError, BreakdownModelUnavailable
from iclip.platform.video_breakdown.service import BreakdownRunner


class ArkVideoBreakdowns:
    def __init__(self, breakdown: BreakdownRunner) -> None:
        self._breakdown = breakdown

    async def breakdown(self, video_url: str) -> str:
        try:
            return await self._breakdown.run(video_url)
        except MediaError as exc:
            raise BreakdownFailed(str(exc), code=ERROR_VIDEO_UNREADABLE) from exc
        except BreakdownModelUnavailable as exc:
            raise BreakdownFailed(str(exc), code=ERROR_MODEL_UNAVAILABLE) from exc
        except BreakdownError as exc:
            code = ERROR_MODEL_CALL_FAILED if exc.retryable else ERROR_MODEL_FAILED
            raise BreakdownFailed(str(exc), code=code) from exc


class ReferenceBreakdownsAdapter:
    def __init__(
        self,
        service: ReferenceService,
        resolve_principal: Callable[[uuid.UUID], Awaitable[Principal]],
    ) -> None:
        self._service = service
        self._resolve_principal = resolve_principal

    async def ensure(self, user_id: uuid.UUID, video_url: str) -> str | FailedBreakdown:
        principal = await self._resolve_principal(user_id)
        outcome = await self._service.ensure(principal, video_url)
        if outcome.document is not None:
            return outcome.document
        if outcome.error_code is None:
            raise RuntimeError(f"参考视频 {video_url} 的拆解既没有文档也没有失败原因")
        return FailedBreakdown(reason=outcome.error_code)


def build_reference_breakdown(
    runtime: RuntimeClient, downloads: MediaDownloads, codec: MediaCodec
) -> ArkVideoBreakdowns:
    model = ArkBreakdownModel(runtime, model=BREAKDOWN_MODEL)
    breakdown = BreakdownRunner(model=model, sampler=FfmpegVideoSampler(downloads, codec))
    return ArkVideoBreakdowns(breakdown)


__all__ = [
    "ArkVideoBreakdowns",
    "ReferenceBreakdownsAdapter",
    "build_reference_breakdown",
]
