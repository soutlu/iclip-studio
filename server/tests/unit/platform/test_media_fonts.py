"""真实静态字体文件的解析与字形覆盖。"""

from __future__ import annotations

from pathlib import Path

import pytest
from fontTools.fontBuilder import FontBuilder
from fontTools.ttLib import TTCollection, TTFont

from iclip.platform.media.fonts import (
    MAX_FONT_BYTES,
    FontError,
    FontStyle,
    inspect_font,
)
from tests.helpers.fonts import make_font


@pytest.mark.parametrize("otf", [False, True], ids=["ttf", "otf"])
@pytest.mark.parametrize("style", ["normal", "italic", "oblique"])
def test_properties_come_from_the_font_not_the_file_name(
    tmp_path: Path, otf: bool, style: FontStyle
) -> None:
    path = make_font(
        tmp_path / "misleading-bold.bin",
        characters=" ABC汉",
        family="Actual Family",
        weight=350,
        style=style,
        otf=otf,
    )

    info = inspect_font(path)

    assert (info.family, info.weight, info.style) == ("Actual Family", 350, style)
    assert info.unicode_ranges == ((32, 32), (65, 67), (ord("汉"), ord("汉")))


def test_win_line_metrics_do_not_decide_whether_a_font_is_usable(tmp_path: Path) -> None:
    """Win 行高度量为 0 的字体照样读得出：只看字族、字重、样式、字形与轮廓。"""

    path = make_font(tmp_path / "no-win-metrics.ttf", characters="A", win_metrics=(0, 0))

    assert inspect_font(path).unicode_ranges == ((ord("A"), ord("A")),)


@pytest.mark.parametrize("kind", ["corrupt", "collection", "variable", "woff"])
def test_non_static_single_fonts_are_rejected(tmp_path: Path, kind: str) -> None:
    source = make_font(tmp_path / "source.ttf")
    path = tmp_path / "unsupported.ttf"
    if kind == "corrupt":
        path.write_bytes(b"this is not a font")
    elif kind == "collection":
        with TTFont(source) as font:
            collection = TTCollection()
            collection.fonts = [font]
            collection.save(path)
    else:
        with TTFont(source) as font:
            if kind == "variable":
                FontBuilder(font=font).setupFvar([("wght", 100, 400, 900, "Weight")], [])
            else:
                font.flavor = "woff"
            font.save(path)

    with pytest.raises(FontError):
        inspect_font(path)


def test_large_or_empty_fonts_are_rejected_before_parsing(tmp_path: Path) -> None:
    path = tmp_path / "large.ttf"
    path.touch()
    with pytest.raises(FontError, match="非空"):
        inspect_font(path)
    with path.open("wb") as handle:
        handle.truncate(MAX_FONT_BYTES + 1)
    with pytest.raises(FontError, match="32 MiB"):
        inspect_font(path)


@pytest.mark.parametrize("otf", [False, True], ids=["ttf", "otf"])
def test_readable_metadata_does_not_hide_a_broken_glyph_outline(tmp_path: Path, otf: bool) -> None:
    path = make_font(tmp_path / "broken.font", characters="A", otf=otf)
    if otf:
        with TTFont(path, recalcBBoxes=False) as font:
            # rmoveto 缺少两个坐标操作数，随后直接 endchar。
            font["CFF "].cff.topDictIndex[0].CharStrings["uni0041"].setBytecode(b"\x15\x0e")
            font.save(path)
    else:
        with TTFont(path) as font:
            glyph_data = font.getTableData("glyf")
            glyph_offset = font["loca"].locations[font.getGlyphID("uni0041")]
        data = bytearray(path.read_bytes())
        assert data.count(glyph_data) == 1
        offset = data.index(glyph_data) + glyph_offset
        # 轮廓记录声称有 32767 条 contour，但字节仍只是原先的一个矩形。
        data[offset : offset + 2] = b"\x7f\xff"
        path.write_bytes(data)

    with TTFont(path) as font:
        assert font["name"].getBestFamilyName() == "Iclip Test"
        assert font.getBestCmap() == {ord("A"): "uni0041"}
    with pytest.raises(FontError, match="字体文件"):
        inspect_font(path)
