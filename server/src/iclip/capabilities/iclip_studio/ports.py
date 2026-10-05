"""iClip Studio 能力的外部依赖协议，由组合根适配对象存储与 ffmpeg。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


class BreakdownError(RuntimeError):
    """视频拆解没有产出可用的文档。"""


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


class SharedBreakdowns(Protocol):
    """所有用户共用的拆解结果，按视频地址存取。

    它只用来省掉重复的模型调用：取不到一律当作没拆过，存不下只记日志，都不让拆解失败。
    """

    async def get(self, video_url: str) -> str | None:
        """这条视频已有的拆解文档；没有或取不到返回 None。"""
        ...

    async def put(self, video_url: str, document: str) -> None:
        """存下这条视频的拆解文档；已有的不覆盖。"""
        ...


__all__ = ["BreakdownError", "SampledVideo", "SharedBreakdowns", "VideoSampler"]
