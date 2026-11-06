from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True, slots=True)
class ImageInfo:
    media_type: str

    size_bytes: int
    width: int
    height: int


class MediaProbeFailed(Exception):
    pass


class MediaProbe(Protocol):
    async def image_info(self, url: str) -> ImageInfo: ...


__all__ = ["ImageInfo", "MediaProbe", "MediaProbeFailed"]
