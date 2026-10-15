"""组合根接上品牌模板的两个适配器：建模板时下载视频用真 ffmpeg 量参数；受理整片时生成域读到的模板
（含停用的、换成在不在用）。"""

from __future__ import annotations

import uuid
from pathlib import Path
from tempfile import TemporaryDirectory

import httpx
import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.app.brand_templates import brand_template_facts, template_video_prober
from iclip.domains.brand_templates.infra_sql import SqlBrandTemplateStore
from iclip.domains.brand_templates.models import ProbedVideo
from iclip.domains.generation.service import BrandTemplateFacts
from iclip.platform.media.ffmpeg import MediaError, ffmpeg_available
from tests.helpers.fork_lineage import make_user
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


async def test_the_whole_film_side_reads_video_templates_and_whether_they_are_in_use(
    engine: AsyncEngine,
) -> None:
    store = SqlBrandTemplateStore(engine)
    creator = await make_user(engine)
    template = await store.create(
        position="outro",
        name="片尾",
        url=VIDEO_URL,
        video=ProbedVideo(width=1080, height=1920, duration_ms=2500, has_audio=False),
        created_by=creator,
        api_key_id=None,
    )
    facts = brand_template_facts(store)

    in_use = await facts(template.id)
    await store.update(template.id, name=None, disabled=True)
    disabled = await facts(template.id)

    assert in_use == BrandTemplateFacts(
        id=template.id,
        position="outro",
        enabled=True,
        url=VIDEO_URL,
        duration_ms=2500,
        width=1080,
        height=1920,
        has_audio=False,
    )
    assert disabled is not None and disabled.enabled is False
    assert await facts(creator) is None, "没有这条模板"

    font_id = uuid.uuid4()
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "INSERT INTO iclip.brand_templates (id, kind, name, url, created_by)"
                " VALUES (:id, 'font', '品牌字体', :url, :creator)"
            ),
            {"id": font_id, "url": "https://cdn.example.test/font.ttf", "creator": creator},
        )
    assert await facts(font_id) is None, "字体不能作为整片的片头片尾视频"
    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE iclip.brand_templates SET duration_ms = NULL WHERE id = :id"),
            {"id": template.id},
        )
    assert await facts(template.id) is None, "缺少时长的资源不能用于视频合成"
