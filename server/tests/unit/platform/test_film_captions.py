"""整片字幕写成的 ASS：画布就是画面、字号随画面高度、时刻写法、ASS 特殊字符换掉、中文按宽度均匀折行。"""

from __future__ import annotations

import re

from iclip.platform.media.ffmpeg import (
    SUBTITLE_FONT,
    SUBTITLE_FONT_SIZE_RATIO,
    FilmCaption,
    ass_document,
)


def _style(document: str) -> list[str]:
    (line,) = [line for line in document.splitlines() if line.startswith("Style: ")]
    return line.removeprefix("Style: ").split(",")


def _texts(document: str) -> list[str]:
    return [
        line.split(",", 9)[9] for line in document.splitlines() if line.startswith("Dialogue: ")
    ]


def test_the_canvas_is_the_picture_and_the_font_follows_its_height() -> None:
    portrait = ass_document([FilmCaption(0, 1, "字")], width=1080, height=1920)
    landscape = ass_document([FilmCaption(0, 1, "字")], width=1920, height=1080)

    assert "PlayResX: 1080\nPlayResY: 1920" in portrait
    assert "WrapStyle: 2" in portrait, "只认服务端折好的行"
    name, size = _style(portrait)[1:3]
    assert (name, int(size)) == (SUBTITLE_FONT, round(1920 * SUBTITLE_FONT_SIZE_RATIO))
    assert int(_style(landscape)[2]) == round(1080 * SUBTITLE_FONT_SIZE_RATIO)
    assert _style(portrait)[18] == "2", "底部居中"


def test_each_caption_is_one_dialogue_at_its_time() -> None:
    document = ass_document(
        [FilmCaption(0.004, 1.5, "第一句"), FilmCaption(61.25, 3725.0, "第二句")],
        width=720,
        height=1280,
    )

    times = re.findall(r"^Dialogue: 0,([^,]+),([^,]+),Default,", document, re.MULTILINE)
    assert times == [("0:00:00.00", "0:00:01.50"), ("0:01:01.25", "1:02:05.00")]
    assert _texts(document) == ["第一句", "第二句"]


def test_ass_override_characters_in_the_text_are_shown_as_typed() -> None:
    (text,) = _texts(ass_document([FilmCaption(0, 1, r"{\b1}加粗\N")], width=720, height=1280))

    assert "{" not in text and "}" not in text and "\\" not in text
    assert text == "｛＼b1｝加粗＼N"


def test_a_long_line_is_split_into_even_lines_that_fit() -> None:
    sentence = "这是一句比较长的整片字幕用来看看折行是否合适并且每行差不多一样长"
    (text,) = _texts(ass_document([FilmCaption(0, 1, sentence)], width=720, height=1280))

    lines = text.split("\\N")
    assert "".join(lines) == sentence
    assert len(lines) == 3
    assert max(map(len, lines)) - min(map(len, lines)) <= 1


def test_explicit_line_breaks_are_kept() -> None:
    (text,) = _texts(ass_document([FilmCaption(0, 1, "上一行\n下一行")], width=720, height=1280))

    assert text == "上一行\\N下一行"
