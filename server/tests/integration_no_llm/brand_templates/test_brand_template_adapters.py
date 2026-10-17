"""组合根接上品牌模板的两个适配器：建模板时下载视频用真 ffmpeg 量参数；上传字体时下载文件读字族、字重、
样式与字形覆盖。"""

from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory

import httpx
import pytest

from iclip.app.brand_templates import template_font_prober, template_video_prober
from iclip.platform.media.errors import MediaError
from iclip.platform.media.process import ffmpeg_available
from tests.helpers.fonts import make_font
from tests.helpers.media import synthesize_video

pytestmark = pytest.mark.anyio

VIDEO_URL = "https://cdn.example.test/iclip/agent/uploads/brand.mp4"
INTERNAL_URL = "https://internal.example.test/iclip/agent/uploads/brand.mp4"


def _transport(payloads: dict[str, bytes]) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        body = payloads.get(str(request.url))
        return httpx.Response(404) if body is None else httpx.Response(200, content=body)

    return httpx.MockTransport(handler)


@pytest.mark.skipif(not ffmpeg_available(), reason="本机 PATH 上没有 ffmpeg/ffprobe")
async def test_the_prober_downloads_through_the_internal_address_and_measures_the_video() -> None:
    with TemporaryDirectory(prefix="brand-fixture-") as tmp:
        content = synthesize_video(Path(tmp) / "brand.mp4", size="320x240", seconds=2, audio=True)
    async with httpx.AsyncClient(transport=_transport({INTERNAL_URL: content})) as client:
        probe = template_video_prober(client, lambda url: url.replace("cdn.", "internal."))
        measured = await probe(VIDEO_URL)
        with pytest.raises(MediaError):
            await probe("https://cdn.example.test/gone.mp4")

    assert (measured.width, measured.height, measured.has_audio) == (320, 240, True)
    assert abs(measured.duration_ms - 2000) <= 100


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
        info = await probe(VIDEO_URL)
        assert info.family == "Brand Caption"
        assert info.weight == 600 and info.style == "italic"
        assert info.unicode_ranges == ((32, 32), (65, 66), (20013, 20013))
        with pytest.raises(MediaError):
            await probe("https://cdn.example.test/bad")
        with pytest.raises(MediaError):
            await probe("https://cdn.example.test/missing")
