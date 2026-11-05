from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO

from PIL import Image


@dataclass(frozen=True, slots=True)
class ImageHeader:
    mime: str | None
    width: int
    height: int


def read_image_header(data: bytes) -> ImageHeader | None:
    try:
        with Image.open(BytesIO(data)) as image:
            fmt = image.format
            width, height = image.size
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError):
        return None
    return ImageHeader(mime=_mime_of(fmt), width=width, height=height)


_JPEG_FAMILY = frozenset({"JPEG", "MPO"})


def _mime_of(fmt: str | None) -> str | None:
    if fmt is None:
        return None
    if fmt in _JPEG_FAMILY:
        return "image/jpeg"
    return Image.MIME.get(fmt)


__all__ = ["ImageHeader", "read_image_header"]
