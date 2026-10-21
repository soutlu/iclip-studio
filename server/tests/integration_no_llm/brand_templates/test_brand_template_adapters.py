"""组合根接上品牌模板的字体适配器：经内网地址下载文件，读字族、字重、样式与字形覆盖。"""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest

from iclip.app.brand_templates import template_font_prober
from iclip.platform.media.errors import MediaError
from tests.helpers.fonts import make_font

pytestmark = pytest.mark.anyio

FONT_URL = "https://cdn.example.test/iclip/agent/uploads/brand.ttf"
INTERNAL_URL = "https://internal.example.test/iclip/agent/uploads/brand.ttf"


def _transport(payloads: dict[str, bytes]) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        body = payloads.get(str(request.url))
        return httpx.Response(404) if body is None else httpx.Response(200, content=body)

    return httpx.MockTransport(handler)


@pytest.mark.parametrize("otf", [False, True], ids=["ttf", "otf"])
async def test_font_metadata_comes_from_the_downloaded_file(tmp_path: Path, otf: bool) -> None:
    font = make_font(
        tmp_path / ("face.otf" if otf else "face.ttf"),
        family="Brand Caption",
        weight=600,
        style="italic",
        characters=" AB中",
        otf=otf,
    )
    async with httpx.AsyncClient(
        transport=_transport(
            {INTERNAL_URL: font.read_bytes(), "https://internal.example.test/bad": b"broken"}
        )
    ) as client:
        probe = template_font_prober(client, lambda url: url.replace("cdn.", "internal."))
        info = await probe(FONT_URL)
        assert info.family == "Brand Caption"
        assert info.weight == 600 and info.style == "italic"
        assert info.unicode_ranges == ((32, 32), (65, 66), (20013, 20013))
        with pytest.raises(MediaError):
            await probe("https://cdn.example.test/bad")
        with pytest.raises(MediaError):
            await probe("https://cdn.example.test/missing")
