"""品牌模板接到别处的两个适配器：建模板时下载视频量参数，受理整片时让生成域读模板。"""

from __future__ import annotations

import uuid
from collections.abc import Callable

import httpx

from iclip.domains.brand_templates.models import ProbedVideo
from iclip.domains.brand_templates.repository import BrandTemplateStore, ProbeVideo
from iclip.domains.generation.service import BrandTemplateFacts, BrandTemplates
from iclip.platform.media.ffmpeg import MAX_VIDEO_BYTES, fetched, probe_duration_ms, probe_video


def template_video_prober(client: httpx.AsyncClient, fetch_url: Callable[[str], str]) -> ProbeVideo:
    """整份下载到临时目录再用 ffprobe 量：画幅与音轨读流信息，时长读容器。``fetch_url`` 把本桶对象
    换成内网地址，记下的仍是原地址。取不到或读不懂抛 ``MediaError``。"""

    async def probe(url: str) -> ProbedVideo:
        async with fetched(
            client, fetch_url(url), max_bytes=MAX_VIDEO_BYTES, suffix=".mp4"
        ) as path:
            profile = await probe_video(path)
            duration_ms = await probe_duration_ms(path)
        return ProbedVideo(
            width=profile.width,
            height=profile.height,
            duration_ms=duration_ms,
            has_audio=profile.has_audio,
        )

    return probe


def brand_template_facts(store: BrandTemplateStore) -> BrandTemplates:
    """生成域按 id 读一条模板（含停用的），换成它认识的形状；两个域互不引用。"""

    async def facts(template_id: uuid.UUID) -> BrandTemplateFacts | None:
        template = await store.get(template_id)
        if template is None:
            return None
        return BrandTemplateFacts(
            id=template.id,
            position=template.position,
            enabled=template.disabled_at is None,
            url=template.url,
            duration_ms=template.duration_ms,
            width=template.width,
            height=template.height,
            has_audio=template.has_audio,
        )

    return facts


__all__ = ["brand_template_facts", "template_video_prober"]
