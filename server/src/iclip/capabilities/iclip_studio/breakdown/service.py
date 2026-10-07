"""一次视频拆解：按时长决定怎么把视频交给模型。"""

from __future__ import annotations

from typing import Final

from iclip.capabilities.iclip_studio.breakdown.model import ArkBreakdownModel
from iclip.capabilities.iclip_studio.ports import VideoSampler

SAMPLED_MAX_SECONDS: Final = 60.0
"""不超过这个时长的视频自己抽帧（每秒 10 帧，切点更准）；更长的把地址交给对方取帧。"""


class VideoBreakdown:
    """拆解一条视频，返回 Markdown 文档原文。

    失败抛 ``MediaError``（取不到或解不开视频）或 ``BreakdownError``（模型没给出可用文档）。
    """

    def __init__(self, *, model: ArkBreakdownModel, sampler: VideoSampler) -> None:
        self._model = model
        self._sampler = sampler

    async def run(self, video_url: str) -> str:
        if await self._sampler.duration_seconds(video_url) <= SAMPLED_MAX_SECONDS:
            return await self._model.from_sample(await self._sampler.sample(video_url))
        return await self._model.from_url(video_url)


__all__ = ["SAMPLED_MAX_SECONDS", "VideoBreakdown"]
