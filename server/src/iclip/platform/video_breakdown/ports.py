"""视频拆解的协议与错误：抽帧端口由 ffmpeg 实现，模型适配器失败抛 ``BreakdownError``，模型没启用另抛它的
子类 ``BreakdownModelUnavailable``。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


class BreakdownError(RuntimeError):
    """视频拆解没有产出可用的文档。"""

    def __init__(self, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.retryable = retryable
        """再调一次有没有可能成功：对方临时出错或答得不完整是 True，请求被拒或等到超时是 False。"""


class BreakdownModelUnavailable(BreakdownError):
    """配置页里没有启用这个模型（或那家供应商没有默认密钥）；要管理员去启用，再调也一样。消息是运行时给的
    原因，说清去哪里改。"""

    def __init__(self, message: str) -> None:
        super().__init__(message, retryable=False)


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


__all__ = [
    "BreakdownError",
    "BreakdownModelUnavailable",
    "SampledVideo",
    "VideoSampler",
]
