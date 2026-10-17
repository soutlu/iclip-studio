from __future__ import annotations

import hashlib
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from itertools import pairwise
from pathlib import Path
from typing import Final, Literal

import uharfbuzz as hb
from fontTools.pens.boundsPen import BoundsPen
from fontTools.ttLib import TTFont

from iclip.platform.media.errors import MediaError

MAX_FONT_BYTES: Final = 32 * 1024 * 1024
# 浏览器 String.prototype.trim 的空白集合，去掉 CR/LF（分行前已统一处理）。
_BROWSER_TRIM_SPACE: Final = "\t\v\f " + "".join(
    map(
        chr,
        (0x00A0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF, *range(0x2000, 0x200B)),
    )
)

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


@dataclass(frozen=True, slots=True)
class SubtitleFont:
    path: Path
    family: str
    info: FontInfo
    ass_size_scale: float
    ass_weight: int
    ass_italic: bool
    metrics: hb.Font

    def measure(self, text: str, *, size: float) -> float:
        if not text:
            return 0.0
        buffer = hb.Buffer()
        buffer.add_str(text)
        buffer.guess_segment_properties()
        hb.shape(self.metrics, buffer)
        return (
            abs(sum(position.x_advance for position in buffer.glyph_positions))
            * size
            / self.metrics.face.upem
        )

    def clusters(self, text: str) -> tuple[str, ...]:
        if not text:
            return ()
        buffer = hb.Buffer()
        buffer.add_str(text)
        buffer.guess_segment_properties()
        hb.shape(self.metrics, buffer)
        boundaries = sorted({0, len(text), *(glyph.cluster for glyph in buffer.glyph_infos)})
        return tuple(text[start:end] for start, end in pairwise(boundaries))


def escape_ass(text: str) -> str:
    # ASS 把反斜杠与花括号当作覆盖标签，换成全角才会照字面显示。
    return text.replace("\\", "＼").replace("{", "｛").replace("}", "｝")


def caption_text(text: str) -> str:
    safe = escape_ass(text).replace("\r\n", "\n").replace("\r", "\n")
    return "\n".join(paragraph.strip(_BROWSER_TRIM_SPACE) for paragraph in safe.split("\n"))


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


def prepare_font(path: Path, *, texts: Sequence[str], directory: Path) -> SubtitleFont:
    inspect_font(path)
    try:
        with TTFont(path, lazy=False) as font:
            digest = hashlib.sha256(path.read_bytes()).hexdigest()[:24]
            return _prepare(font, texts=texts, directory=directory, family=f"IclipSubtitle{digest}")
    except FontError:
        raise
    except Exception as exc:
        raise FontError("无法准备选定的字幕字体") from exc


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
    _ass_size_scale(font)
    return FontInfo(family.strip(), weight, style, tuple(ranges))


def _ass_size_scale(font: TTFont) -> float:
    # libass ass_font.c/set_font_metrics 用 Win ascent+descent；ass_face_set_size 使用
    # FT_SIZE_REQUEST_TYPE_REAL_DIM。浏览器 size 是 em，按文件度量换算。
    em = _integer(font, "head", "unitsPerEm")
    ascent = _integer(font, "OS/2", "usWinAscent")
    descent = _integer(font, "OS/2", "usWinDescent")
    if em <= 0 or not 0 <= ascent < 32768 or not 0 <= descent < 32768 or ascent + descent <= 0:
        raise FontError("字体缺少有效的 em 或行高度量")
    return (ascent + descent) / em


def _prepare(font: TTFont, *, texts: Sequence[str], directory: Path, family: str) -> SubtitleFont:
    info = _info(font)
    cmap = font.getBestCmap()
    assert cmap is not None
    missing = sorted(
        {
            ord(char)
            for text in texts
            for char in caption_text(text)
            if char != "\n" and (ord(char) not in cmap or font.getGlyphID(cmap[ord(char)]) == 0)
        }
    )
    if missing:
        samples = "、".join(f"{chr(code)}（U+{code:04X}）" for code in missing[:12])
        raise FontError(f"所选字体缺少字幕字符：{samples}，请更换字体或修改字幕")
    # libass 按字族名找字体，同字族的其它字重或系统里的同名字体都可能被选中，所以副本换成独有的字族名。
    names = font["name"]
    for record in names.names:
        if record.nameID in (1, 3, 4, 6, 16, 18, 21):
            encoding = record.getEncoding()
            if encoding is None:
                raise FontError("字体名称表包含无法识别的编码")
            record.string = family.encode(encoding)
    for name_id in (1, 3, 4, 6, 16, 21):
        names.setName(family, name_id, 3, 1, 0x409)
    if "CFF " in font:
        cff = font["CFF "].cff
        cff.fontNames = [family]
        top = cff.topDictIndex[0]
        top.FamilyName = family
        top.FullName = family
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / (family + (".otf" if font.sfntVersion == "OTTO" else ".ttf"))
    font.save(target)
    # libass 把 OS/2 里 1..9 的旧式字重当作这几档。
    weight = (
        (100, 200, 300, 350, 400, 600, 700, 800, 900)[info.weight - 1]
        if info.weight <= 9
        else info.weight
    )
    return SubtitleFont(
        target,
        family,
        info,
        _ass_size_scale(font),
        weight,
        bool(_integer(font, "OS/2", "fsSelection") & 1),
        hb.Font(hb.Face(target.read_bytes())),
    )


__all__ = [
    "MAX_FONT_BYTES",
    "FontError",
    "FontInfo",
    "FontStyle",
    "ProbeFont",
    "SubtitleFont",
    "caption_text",
    "escape_ass",
    "inspect_font",
    "prepare_font",
]
