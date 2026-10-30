"""参考视频的拆解：把 references 声明的拆解端口接到 ``video_breakdown`` 的拆解（``BreakdownRunner``）上；
反过来把 ``video_breakdown`` 的 ``ReferenceBreakdowns`` 端口接到参考视频服务上。打标在
[library_tagging.py](library_tagging.py)。"""

from __future__ import annotations

from collections.abc import Callable

import httpx

from iclip.config import ResolvedIclipStudio
from iclip.domains.identity.public import Principal
from iclip.domains.references.models import (
    ERROR_MODEL_CALL_FAILED,
    ERROR_MODEL_FAILED,
    ERROR_VIDEO_UNREADABLE,
    BreakdownFailed,
)
from iclip.domains.references.service import ReferenceService
from iclip.platform.media.codec import MediaCodec
from iclip.platform.media.errors import MediaError
from iclip.plugins.video_breakdown.media import FfmpegVideoSampler
from iclip.plugins.video_breakdown.model import ArkBreakdownModel
from iclip.plugins.video_breakdown.ports import BreakdownError, FailedBreakdown
from iclip.plugins.video_breakdown.service import BreakdownRunner


class ArkVideoBreakdowns:
    """``VideoBreakdowns`` 的实现：用 ``BreakdownRunner`` 拆，把它的两种失败换成落到行上的原因。"""

    def __init__(self, breakdown: BreakdownRunner) -> None:
        self._breakdown = breakdown

    async def breakdown(self, video_url: str) -> str:
        try:
            return await self._breakdown.run(video_url)
        except MediaError as exc:
            raise BreakdownFailed(str(exc), code=ERROR_VIDEO_UNREADABLE) from exc
        except BreakdownError as exc:
            # 可重试的（限流、服务端错、连不上、答得不完整）再拆可能就好；被拒与等满总超时不会。
            code = ERROR_MODEL_CALL_FAILED if exc.retryable else ERROR_MODEL_FAILED
            raise BreakdownFailed(str(exc), code=code) from exc


class ReferenceBreakdownsAdapter:
    """``video_breakdown`` 的 ``ReferenceBreakdowns``：接到参考视频服务的 ``ensure``，与资料库读写同一行。"""

    def __init__(self, service: ReferenceService) -> None:
        self._service = service

    async def ensure(self, principal: Principal, video_url: str) -> str | FailedBreakdown:
        outcome = await self._service.ensure(principal, video_url)
        if outcome.document is not None:
            return outcome.document
        if outcome.error_code is None:
            raise RuntimeError(f"参考视频 {video_url} 的拆解既没有文档也没有失败原因")
        return FailedBreakdown(reason=outcome.error_code)


def build_reference_breakdown(
    settings: ResolvedIclipStudio,
    client: httpx.AsyncClient,
    codec: MediaCodec,
    *,
    fetch_url: Callable[[str], str],
) -> ArkVideoBreakdowns:
    """按 ``iclip_studio`` 的配置建参考视频自己的一份拆解；HTTP 连接池与组合根共用，抽帧解码用启动时
    选定的 ``codec``，探时长与下载视频前用 ``fetch_url`` 换算地址。"""

    model = ArkBreakdownModel(
        client,
        url=settings.breakdown_url,
        api_key=settings.breakdown_api_key,
        model=settings.breakdown_model,
    )
    breakdown = BreakdownRunner(
        model=model, sampler=FfmpegVideoSampler(client, codec, fetch_url=fetch_url)
    )
    return ArkVideoBreakdowns(breakdown)


__all__ = [
    "ArkVideoBreakdowns",
    "ReferenceBreakdownsAdapter",
    "build_reference_breakdown",
]
