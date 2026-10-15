"""真实静态字体文件的解析、覆盖、字族隔离与 HarfBuzz 字形度量。"""

from __future__ import annotations

from pathlib import Path

import pytest
from fontTools.fontBuilder import FontBuilder
from fontTools.ttLib import TTCollection, TTFont

from iclip.platform.media.fonts import (
    MAX_FONT_BYTES,
    FontError,
    FontStyle,
    caption_text,
    inspect_font,
    prepare_font,
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
def test_the_selected_face_has_a_private_family_without_changing_its_glyphs(
    tmp_path: Path, otf: bool
) -> None:
    light = make_font(
        tmp_path / "light.font", characters="Wi", weight=300, otf=otf, advances={"W": 900, "i": 200}
    )
    bold = make_font(
        tmp_path / "bold.font", characters="Wi", weight=700, otf=otf, advances={"W": 1000, "i": 300}
    )
    original = light.read_bytes()

    selected = prepare_font(light, texts=["Wi"], directory=tmp_path / "first")
    other = prepare_font(bold, texts=["Wi"], directory=tmp_path / "second")

    assert selected.family != other.family
    assert (selected.info.family, other.info.family) == ("Iclip Test", "Iclip Test")
    assert inspect_font(selected.path).family == selected.family
    assert (selected.ass_weight, other.ass_weight) == (300, 700)
    assert selected.ass_size_scale == pytest.approx(1.2)
    assert selected.measure("Wi", size=100) == pytest.approx(110)
    assert other.measure("Wi", size=100) == pytest.approx(130)
    assert light.read_bytes() == original


@pytest.mark.parametrize("text", ["A汉", "A\u200dA", "A\ufe0f", "A\tA"])
def test_missing_characters_never_use_system_fallback(tmp_path: Path, text: str) -> None:
    source = make_font(tmp_path / "latin.ttf", characters="A")

    with pytest.raises(FontError, match="缺少字幕字符"):
        prepare_font(source, texts=[text], directory=tmp_path / "render")
    assert not (tmp_path / "render").exists()


def test_coverage_checks_the_characters_that_will_actually_be_burned(tmp_path: Path) -> None:
    source = make_font(tmp_path / "literal.ttf", characters="A{}\\")
    assert caption_text("  A\r\n{\\A}  ") == "A\n｛＼A｝"
    assert caption_text("\ufeffA\u3000\n\tA\t") == "A\nA"
    assert caption_text("A\u0085") == "A\u0085", "与浏览器 trim 一致，不吞掉其它控制字符"

    with pytest.raises(FontError, match="U\\+FF5B"):
        prepare_font(source, texts=["{\\A}"], directory=tmp_path / "render")


def test_newlines_are_layout_separators_not_missing_glyphs(tmp_path: Path) -> None:
    source = make_font(tmp_path / "latin.ttf", characters="A")
    selected = prepare_font(source, texts=[" A\r\nA "], directory=tmp_path / "render")

    assert selected.measure("AA", size=20) == pytest.approx(40)
