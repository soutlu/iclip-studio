"""只读图片文件头：格式与宽高，不解码像素。"""

from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO

from PIL import Image


@dataclass(frozen=True, slots=True)
class ImageHeader:
    """文件头里读出来的事实。``mime`` 按 Pillow 认出的格式定，不看谁报的 Content-Type。"""

    mime: str | None
    """Pillow 认得格式但没有对应 MIME 时为 None。"""
    width: int
    height: int


def read_image_header(data: bytes) -> ImageHeader | None:
    """读出格式与宽高；``Image.open`` 只解析文件头，像素留到真用时才解码。读不出来（不是图片、
    文件头坏了、尺寸大到 Pillow 当成解压炸弹）就交回 None，算不是图片。"""

    try:
        with Image.open(BytesIO(data)) as image:
            fmt = image.format
            width, height = image.size
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError):
        # UnidentifiedImageError 是 OSError；文件头坏了时各家解码器抛 ValueError / SyntaxError。
        return None
    return ImageHeader(mime=_mime_of(fmt), width=width, height=height)


_JPEG_FAMILY = frozenset({"JPEG", "MPO"})
"""手机、相机拍的 JPEG 常带多帧扩展（MPO：第一帧是普通 baseline JPEG，后面挂深度图或预览），
Pillow 认成 ``MPO``、MIME 给 ``image/mpo``；浏览器与 OSS 都把它当 jpg 处理，按 ``image/jpeg`` 算。"""


def _mime_of(fmt: str | None) -> str | None:
    if fmt is None:
        return None
    if fmt in _JPEG_FAMILY:
        return "image/jpeg"
    return Image.MIME.get(fmt)


__all__ = ["ImageHeader", "read_image_header"]
