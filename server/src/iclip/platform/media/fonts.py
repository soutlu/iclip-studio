"""静态字幕字体：读取文件本身的属性、校验字符覆盖，为 libass 准备独立字族。

同名的不同字重不能交给系统字体匹配器猜。每次渲染使用只含选定字形的临时副本，
仅重命名字族与 PostScript 名；原文件、轮廓、字重、字形度量均保持不变。
"""

from __future__ import annotations

import hashlib
from collections.abc import Sequence
from dataclasses import dataclass
from itertools import pairwise
from pathlib import Path
from typing import Final, Literal

import uharfbuzz as hb
from fontTools.pens.boundsPen import BoundsPen
from fontTools.ttLib import TTFont

from iclip.platform.media.errors import MediaError

MAX_FONT_BYTES: Final = 32 * 1024 * 1024
_TRIM_SPACE: Final = "\t\v\f \u00a0\u1680\u2028\u2029\u202f\u205f\u3000\ufeff" + "".join(
    chr(code) for code in range(0x2000, 0x200B)
)
"""浏览器 String.trim 的空白集合；CR/LF 在分行前统一处理。"""

FontStyle = Literal["normal", "italic", "oblique"]


class FontError(MediaError):
    """字体文件无效、不受支持、缺字或未被渲染器实际采用。"""


@dataclass(frozen=True, slots=True)
class FontInfo:
    """从文件读取的字族、字重、样式与 Unicode 覆盖；范围是递增的不相交闭区间。"""

    family: str
    weight: int
    style: FontStyle
    unicode_ranges: tuple[tuple[int, int], ...]


@dataclass(frozen=True, slots=True)
class SubtitleFont:
    """一条整片专用的字体副本，以及浏览器 em 到 ASS 行高字号的换算。"""

    path: Path
    family: str
    info: FontInfo
    ass_size_scale: float
    ass_weight: int
    ass_italic: bool
    metrics: hb.Font

    def measure(self, text: str, *, size: float) -> float:
        """按浏览器 em 像素大小，用同一文件的 HarfBuzz 字形推进量测量整行。"""

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
        """按 HarfBuzz 字形簇分割，折行不拆开组合字符和连字。"""

        if not text:
            return ()
        buffer = hb.Buffer()
        buffer.add_str(text)
        buffer.guess_segment_properties()
        hb.shape(self.metrics, buffer)
        boundaries = sorted({0, len(text), *(glyph.cluster for glyph in buffer.glyph_infos)})
        return tuple(text[start:end] for start, end in pairwise(boundaries))


def caption_text(text: str) -> str:
    """与 ASS 输出一致的文字；特殊字符转全角，换行保留，首尾空白不参与排版。"""

    safe = text.replace("\\", "＼").replace("{", "｛").replace("}", "｝")
    safe = safe.replace("\r\n", "\n").replace("\r", "\n")
    return "\n".join(paragraph.strip(_TRIM_SPACE) for paragraph in safe.split("\n"))


def inspect_font(path: Path) -> FontInfo:
    """读取一份静态 TTF/OTF；拒绝集合、可变字体与网页封装，失败抛 FontError。"""

    try:
        if not 0 < path.stat().st_size <= MAX_FONT_BYTES:
            raise FontError(f"字体必须非空且不超过 {MAX_FONT_BYTES // 1024 // 1024} MiB")
        with TTFont(path, lazy=False) as font:
            info = _info(font)
            font.ensureDecompiled(recurse=True)
            # CFF 的 CharStrings 仍按需读取；逐字形解码，不能只验证名称和 cmap。
            glyphs = font.getGlyphSet()
            for name in font.getGlyphOrder():
                glyphs[name].draw(BoundsPen(glyphs))
            return info
    except FontError:
        raise
    except Exception as exc:
        raise FontError("无法读取静态 TTF/OTF 字体文件") from exc


def prepare_font(path: Path, *, texts: Sequence[str], directory: Path) -> SubtitleFont:
    """验证选定文件和全部字幕，写入独立字族副本；调用方负责清理 directory。"""

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
    # 字族来自原文件哈希；仅更改名称表，保留轮廓和度量。
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
    # libass 对旧式 OS/2 1..9 字重的解释；force_style 避免 ASS 样式把字重布尔化。
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
    "SubtitleFont",
    "caption_text",
    "inspect_font",
    "prepare_font",
]
