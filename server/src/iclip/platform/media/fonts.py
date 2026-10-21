from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Literal

from fontTools.pens.boundsPen import BoundsPen
from fontTools.ttLib import TTFont

from iclip.platform.media.errors import MediaError

MAX_FONT_BYTES: Final = 32 * 1024 * 1024

FontStyle = Literal["normal", "italic", "oblique"]


class FontError(MediaError):
    pass


@dataclass(frozen=True, slots=True)
class FontInfo:
    family: str
    weight: int
    style: FontStyle
    unicode_ranges: tuple[tuple[int, int], ...]


ProbeFont = Callable[[str], Awaitable[FontInfo]]


def inspect_font(path: Path) -> FontInfo:
    try:
        if not 0 < path.stat().st_size <= MAX_FONT_BYTES:
            raise FontError(f"字体必须非空且不超过 {MAX_FONT_BYTES // 1024 // 1024} MiB")
        with TTFont(path, lazy=False) as font:
            info = _info(font)
            font.ensureDecompiled(recurse=True)
            # CFF 的 CharStrings 在 ensureDecompiled 之后仍按需解码，要逐字形画一遍才验得出坏轮廓。
            glyphs = font.getGlyphSet()
            for name in font.getGlyphOrder():
                glyphs[name].draw(BoundsPen(glyphs))
            return info
    except FontError:
        raise
    except Exception as exc:
        raise FontError("无法读取静态 TTF/OTF 字体文件") from exc


def _integer(font: TTFont, table: str, name: str) -> int:
    value: object = getattr(font[table], name, None)
    if not isinstance(value, int):
        raise FontError(f"字体缺少有效的 {table}.{name}")
    return value


def _info(font: TTFont) -> FontInfo:
    if font.flavor is not None or font.sfntVersion not in ("\x00\x01\x00\x00", "OTTO"):
        raise FontError("只支持静态 TTF/OTF 字体")
    if "fvar" in font or "gvar" in font or "CFF2" in font:
        raise FontError("暂不支持可变字体，请选择静态 TTF/OTF")
    if "glyf" not in font and "CFF " not in font:
        raise FontError("字体没有可用的轮廓")
    family: object = font["name"].getBestFamilyName()
    if not isinstance(family, str) or not family.strip():
        raise FontError("字体没有有效的字族名称")
    weight = _integer(font, "OS/2", "usWeightClass")
    if not 1 <= weight <= 1000:
        raise FontError("字体字重不在 1 到 1000 之间")
    selection = _integer(font, "OS/2", "fsSelection")
    style: FontStyle = (
        "oblique" if selection & (1 << 9) else "italic" if selection & 1 else "normal"
    )
    cmap = font.getBestCmap()
    if not cmap:
        raise FontError("字体没有 Unicode 字符映射")
    points = sorted(code for code, glyph in cmap.items() if font.getGlyphID(glyph) != 0)
    if not points:
        raise FontError("字体没有可用的 Unicode 字形")
    ranges: list[tuple[int, int]] = []
    start = end = points[0]
    for point in points[1:]:
        if point == end + 1:
            end = point
        else:
            ranges.append((start, end))
            start = end = point
    ranges.append((start, end))
    return FontInfo(family.strip(), weight, style, tuple(ranges))


__all__ = [
    "MAX_FONT_BYTES",
    "FontError",
    "FontInfo",
    "FontStyle",
    "ProbeFont",
    "inspect_font",
]
