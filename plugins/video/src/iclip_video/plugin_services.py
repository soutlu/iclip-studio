from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class _Wire(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class ShotVideoServices(_Wire):
    image_models: tuple[str, ...]


class PluginServices(_Wire):
    shot_video: ShotVideoServices | None
    video_breakdown: bool


__all__ = ["PluginServices", "ShotVideoServices"]
