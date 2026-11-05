from __future__ import annotations

from typing import Final

from iclip.platform.video_breakdown.model import ArkBreakdownModel
from iclip.platform.video_breakdown.ports import VideoSampler

SAMPLED_MAX_SECONDS: Final = 60.0


class BreakdownRunner:
    def __init__(self, *, model: ArkBreakdownModel, sampler: VideoSampler) -> None:
        self._model = model
        self._sampler = sampler

    async def run(self, video_url: str) -> str:
        sampled = await self._sampler.sample_up_to(video_url, max_seconds=SAMPLED_MAX_SECONDS)
        if sampled is not None:
            return await self._model.from_sample(sampled)
        return await self._model.from_url(video_url)


__all__ = ["SAMPLED_MAX_SECONDS", "BreakdownRunner"]
