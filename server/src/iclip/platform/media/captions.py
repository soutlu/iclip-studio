from __future__ import annotations

import math
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Protocol

from iclip.platform.media.fonts import FontError, SubtitleFont, caption_text, escape_ass
from iclip.platform.media.video import SubtitleBurn

_WIDE_GLYPH_EM: Final = 0.7
_NARROW_GLYPH_EM: Final = 0.45


@dataclass(frozen=True, slots=True)
class CaptionStyle:
    font_size_of_height: float
    outline_of_font_size: float
    bottom_margin_of_height: float
    side_margin_of_width: float


@dataclass(frozen=True, slots=True)
class Caption:
    start: float
    end: float
    text: str


class CaptionFont(Protocol):
    @property
    def family(self) -> str: ...

    @property
    def ass_bold(self) -> int: ...

    @property
    def ass_italic(self) -> int: ...

    def to_pixels(self, value: float) -> int: ...

    def ass_font_size(self, font_size: int) -> float: ...

    def line_width(self, available: int, *, outline: int) -> int: ...

    def lines(self, text: str, *, font_size: int, line_width: int) -> list[str]: ...

    def burn(self, document: Path) -> SubtitleBurn: ...


@dataclass(frozen=True, slots=True)
class EstimatedCaptionFont:
    family: str
    fonts_dir: Path

    @property
    def ass_bold(self) -> int:
        return -1

    @property
    def ass_italic(self) -> int:
        return 0

    def to_pixels(self, value: float) -> int:
        return round(value)

    def ass_font_size(self, font_size: int) -> float:
        return font_size

    def line_width(self, available: int, *, outline: int) -> int:
        return available

    def lines(self, text: str, *, font_size: int, line_width: int) -> list[str]:
        lines: list[str] = []
        for paragraph in escape_ass(text).splitlines():
            lines += _estimated_wrap(paragraph.strip(), font_size=font_size, line_width=line_width)
        return lines

    def burn(self, document: Path) -> SubtitleBurn:
        return SubtitleBurn(
            document=document, fonts_dir=self.fonts_dir, force_style=None, verify_log=None
        )


@dataclass(frozen=True, slots=True)
class ShapedCaptionFont:
    font: SubtitleFont

    @property
    def family(self) -> str:
        return self.font.family

    @property
    def ass_bold(self) -> int:
        return 0

    @property
    def ass_italic(self) -> int:
        return int(self.font.ass_italic)

    def to_pixels(self, value: float) -> int:
        return math.floor(value + 0.5)

    def ass_font_size(self, font_size: int) -> float:
        return font_size * self.font.ass_size_scale

    def line_width(self, available: int, *, outline: int) -> int:
        return available - 2 * outline

    def lines(self, text: str, *, font_size: int, line_width: int) -> list[str]:
        lines: list[str] = []
        for paragraph in caption_text(text).split("\n"):
            lines += self._wrap(paragraph, font_size=font_size, line_width=line_width)
        return lines

    def burn(self, document: Path) -> SubtitleBurn:
        # ASS 样式里的 Bold 会被 libass 当成布尔值，精确字重只能经 force_style 给。
        return SubtitleBurn(
            document=document,
            fonts_dir=self.font.path.parent,
            force_style=f"Bold={self.font.ass_weight},Italic={int(self.font.ass_italic)}",
            verify_log=self._check_selected_font,
        )

    def _wrap(self, paragraph: str, *, font_size: int, line_width: int) -> list[str]:
        lines: list[str] = []
        line = ""
        for cluster in self.font.clusters(paragraph):
            candidate = line + cluster
            if self.font.measure(candidate, size=font_size) > line_width:
                if not line or self.font.measure(cluster, size=font_size) > line_width:
                    raise FontError("字幕字形超过可用画面宽度，请调整字幕或字体")
                lines.append(caption_text(line))
                line = caption_text(cluster)
            else:
                line = candidate
        if line:
            lines.append(caption_text(line))
        return lines

    def _check_selected_font(self, log: str) -> None:
        # libass 在 info 级日志里每选一次字体写一行「fontselect: (…) -> 文件, 序号, 字族」，
        # 字体里找不到的字形写「Glyph 0x…」。
        selections = [line for line in log.splitlines() if "fontselect:" in line]
        if (
            not selections
            or any(
                "->" not in line or not line.rstrip().endswith(f", {self.font.family}")
                for line in selections
            )
            or "Glyph 0x" in log
        ):
            raise FontError("字幕渲染未使用完整的选定字体，已停止导出")


def ass_document(
    captions: Sequence[Caption],
    *,
    width: int,
    height: int,
    style: CaptionStyle,
    font: CaptionFont,
) -> str:
    font_size = max(1, font.to_pixels(height * style.font_size_of_height))
    outline = max(1, font.to_pixels(font_size * style.outline_of_font_size))
    margin_side = font.to_pixels(width * style.side_margin_of_width)
    margin_bottom = font.to_pixels(height * style.bottom_margin_of_height)
    line_width = max(font_size, font.line_width(width - 2 * margin_side, outline=outline))
    header = "\n".join(
        [
            "[Script Info]",
            "ScriptType: v4.00+",
            f"PlayResX: {width}",
            f"PlayResY: {height}",
            # libass 不会在没有空格的中文里折行；2 表示只认显式的 \N。
            "WrapStyle: 2",
            "ScaledBorderAndShadow: yes",
            "",
            "[V4+ Styles]",
            "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour,"
            " BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle,"
            " BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
            f"Style: Default,{font.family},{font.ass_font_size(font_size):g},&H00FFFFFF,"
            f"&H00FFFFFF,&H00000000,&H00000000,{font.ass_bold},{font.ass_italic},0,0,100,100,0,0,"
            f"1,{outline},0,2,{margin_side},{margin_side},{margin_bottom},1",
            "",
            "[Events]",
            "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
        ]
    )
    events = [
        f"Dialogue: 0,{_ass_time(caption.start)},{_ass_time(caption.end)},Default,,0,0,0,,"
        + "\\N".join(
            line
            for line in font.lines(caption.text, font_size=font_size, line_width=line_width)
            if line
        )
        for caption in captions
    ]
    return "\n".join([header, *events, ""])


def _ass_time(seconds: float) -> str:
    centis = round(seconds * 100)
    hours, rest = divmod(centis, 360_000)
    minutes, rest = divmod(rest, 6_000)
    whole, centi = divmod(rest, 100)
    return f"{hours}:{minutes:02d}:{whole:02d}.{centi:02d}"


def _estimated_wrap(paragraph: str, *, font_size: int, line_width: int) -> list[str]:
    widths = [
        font_size
        * (_WIDE_GLYPH_EM if unicodedata.east_asian_width(char) in ("W", "F") else _NARROW_GLYPH_EM)
        for char in paragraph
    ]
    total = sum(widths)
    if total <= line_width:
        return [paragraph]
    count = math.ceil(total / max(1.0, line_width - max(widths)))
    share = total / count
    lines = [""] * count
    used = 0.0
    for char, width in zip(paragraph, widths, strict=True):
        lines[min(count - 1, int((used + width / 2) / share))] += char
        used += width
    return [line.strip() for line in lines]


__all__ = [
    "Caption",
    "CaptionFont",
    "CaptionStyle",
    "EstimatedCaptionFont",
    "ShapedCaptionFont",
    "ass_document",
]
