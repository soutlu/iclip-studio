from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Final, Literal

MediaKind = Literal["image", "video", "audio"]

UPLOAD_TYPES: Final[Mapping[str, tuple[MediaKind, str]]] = {
    "image/jpeg": ("image", "jpg"),
    "image/png": ("image", "png"),
    "image/webp": ("image", "webp"),
    "video/mp4": ("video", "mp4"),
    "video/quicktime": ("video", "mov"),
    "audio/mpeg": ("audio", "mp3"),
    "audio/wav": ("audio", "wav"),
    "audio/mp4": ("audio", "m4a"),
}

MAX_BYTES: Final[Mapping[MediaKind, int]] = {
    "image": 16 * 1024 * 1024,
    "video": 512 * 1024 * 1024,
    "audio": 50 * 1024 * 1024,
}

MIN_SHORT_EDGE_PIXELS: Final = 300
MAX_LONG_EDGE_PIXELS: Final = 6000


@dataclass(frozen=True, slots=True)
class ConfirmedUpload:
    url: str
    content_type: str
    size_bytes: int


__all__ = [
    "MAX_BYTES",
    "MAX_LONG_EDGE_PIXELS",
    "MIN_SHORT_EDGE_PIXELS",
    "UPLOAD_TYPES",
    "ConfirmedUpload",
    "MediaKind",
]
