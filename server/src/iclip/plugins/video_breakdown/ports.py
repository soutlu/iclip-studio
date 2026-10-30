"""视频拆解能力的外部依赖协议，由组合根适配 ffmpeg 与参考视频。"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Literal, Protocol


class BreakdownError(RuntimeError):
    """视频拆解没有产出可用的文档。"""

    def __init__(self, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.retryable = retryable
        """再调一次有没有可能成功：对方临时出错或答得不完整是 True，请求被拒或等到超时是 False。"""


@dataclass(frozen=True, slots=True)
class SampledVideo:
    """从一条视频里按固定帧率抽出的帧与整条音轨。"""

    frames: tuple[bytes, ...]
    """时间升序的 JPEG；第 i 帧对应 i / 帧率 秒。"""

    audio: bytes | None
    """整条音轨的 MP3；视频没有音轨时为 None。"""


class VideoSampler(Protocol):
    """读视频时长，并为模型准备帧与音轨。失败抛 ``MediaError``。"""

    async def duration_seconds(self, video_url: str) -> float:
        """不下载整片，只读时长。"""
        ...

    async def sample(self, video_url: str) -> SampledVideo:
        """下载视频，抽帧并取出音轨。"""
        ...


BreakdownFailureReason = Literal["video_unreadable", "model_call_failed", "model_failed", "timeout"]
"""一次拆解为什么没拿到文档。``video_unreadable`` 视频取不到或解不开；``model_call_failed`` 模型调用
失败（限流、服务端错、连不上、答得不完整），再拆可能就好；``model_failed`` 请求被拒或等满了总超时；
``timeout`` 等满了上限还没拆完。"""


@dataclass(frozen=True, slots=True)
class FailedBreakdown:
    """这条视频这次没拆成。"""

    reason: BreakdownFailureReason


class ReferenceBreakdowns(Protocol):
    """参考视频的拆解：所有对话与资料库共用一份，按视频地址认。"""

    async def ensure(self, user_id: uuid.UUID, video_url: str) -> str | FailedBreakdown:
        """交回这条视频的拆解文档：已有就直接给；没有或上次没拆成就排一次拆解，等到出结果。
        ``user_id`` 是运行属主，实现方每次按它重建主体。"""
        ...


__all__ = [
    "BreakdownError",
    "BreakdownFailureReason",
    "FailedBreakdown",
    "ReferenceBreakdowns",
    "SampledVideo",
    "VideoSampler",
]
