"""整片渲染的声音参数与默认字体下的字幕排版，存成 contract/whole-film/render-golden.json，前端预览读
同一份核对自己的常量与折行；改了常量或排版用 UPDATE_GOLDEN=1 重写。"""

from __future__ import annotations

from typing import Any

from iclip.domains.generation.film_render import CAPTION_STYLE, DEFAULT_CAPTION_FONT
from iclip.domains.generation.film_schemas import WholeFilmRender
from iclip.platform.media.audio import MAX_LOUDNESS_BOOST_DB
from iclip.platform.media.captions import (
    ESTIMATED_NARROW_GLYPH_EM,
    ESTIMATED_WIDE_GLYPH_EM,
    caption_layout,
)
from tests.helpers.golden import CONTRACT_DIR, check_golden_file

CAPTION_CASES: list[tuple[int, int, str]] = [
    (1080, 1920, "大家好，欢迎来到今天的直播间"),
    (1920, 1080, "大家好，欢迎来到今天的直播间"),
    (1080, 1920, "这款 iPhone 15 Pro 的 A17 芯片真的很快"),
    (1080, 1920, "第一行说产品\n第二行说价格"),
    (
        1080,
        1920,
        "这双鞋的鞋底用了新一代的缓震材料，走一整天也不累脚，鞋面是透气的网布，夏天穿也不闷，"
        "颜色有黑白灰三种可以选",
    ),
    (720, 1280, "Lightweight running shoes with breathable mesh for everyday training"),
    (975, 1300, "画面高度乘字号比例恰好落在半像素上"),
]


def _caption(width: int, height: int, text: str) -> dict[str, Any]:
    layout = caption_layout(
        width=width, height=height, style=CAPTION_STYLE, font=DEFAULT_CAPTION_FONT
    )
    return {
        "width": width,
        "height": height,
        "text": text,
        "fontSize": layout.font_size,
        "outline": layout.outline,
        "marginSide": layout.margin_side,
        "marginBottom": layout.margin_bottom,
        "lineWidth": layout.line_width,
        "lines": DEFAULT_CAPTION_FONT.lines(
            text, font_size=layout.font_size, line_width=layout.line_width
        ),
    }


def test_the_render_constants_and_default_caption_layout_match_the_golden() -> None:
    check_golden_file(
        CONTRACT_DIR / "whole-film" / "render-golden.json",
        {
            "audio": {
                **WholeFilmRender().model_dump(mode="json", by_alias=True),
                "maxLoudnessBoostDb": MAX_LOUDNESS_BOOST_DB,
            },
            "captionStyle": {
                "fontSizeOfHeight": CAPTION_STYLE.font_size_of_height,
                "outlineOfFontSize": CAPTION_STYLE.outline_of_font_size,
                "bottomMarginOfHeight": CAPTION_STYLE.bottom_margin_of_height,
                "sideMarginOfWidth": CAPTION_STYLE.side_margin_of_width,
            },
            "defaultFont": {
                "wideGlyphEm": ESTIMATED_WIDE_GLYPH_EM,
                "narrowGlyphEm": ESTIMATED_NARROW_GLYPH_EM,
            },
            "captions": [_caption(width, height, text) for width, height, text in CAPTION_CASES],
        },
    )
