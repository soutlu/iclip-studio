"""品牌资源适配：下载视频量参数、读取字体信息，向整片受理提供资源事实。"""

from __future__ import annotations

import asyncio
import hashlib
import uuid
from collections.abc import Callable

import httpx

from iclip.common.errors import ValidationFailed
from iclip.domains.brand_templates.models import ProbedVideo
from iclip.domains.brand_templates.repository import BrandTemplateStore, ProbeFont, ProbeVideo
from iclip.domains.generation.service import BrandTemplateFacts, BrandTemplates
from iclip.platform.media.ffmpeg import (
    MAX_VIDEO_BYTES,
    MediaError,
    fetched,
    probe_duration_ms,
    probe_video,
)
from iclip.platform.media.fonts import MAX_FONT_BYTES, FontInfo, inspect_font


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


def brand_template_facts(store: BrandTemplateStore, *, probe_font: ProbeFont) -> BrandTemplates:
    """生成域按 id 读取资源事实，字体另取文件内部属性；两个业务域互不引用。"""

    async def facts(template_id: uuid.UUID) -> BrandTemplateFacts | None:
        template = await store.get(template_id)
        if template is None:
            return None
        info = None
        if template.kind == "font" and template.disabled_at is None:
            try:
                info = await probe_font(template.url)
            except MediaError as exc:
                raise ValidationFailed(f"字体无法使用：{exc}") from exc
        return BrandTemplateFacts(
            id=template.id,
            kind=template.kind,
            name=template.name,
            font_info=info,
            enabled=template.disabled_at is None,
            url=template.url,
            duration_ms=template.duration_ms,
            width=template.width,
            height=template.height,
            has_audio=template.has_audio,
        )

    return facts


def template_font_prober(client: httpx.AsyncClient, fetch_url: Callable[[str], str]) -> ProbeFont:
    """下载指定字体并读取内部信息；解析结果按内容缓存，不把家族名猜成文件名。"""

    cache: dict[str, FontInfo] = {}

    async def probe(url: str) -> FontInfo:
        async with fetched(client, fetch_url(url), max_bytes=MAX_FONT_BYTES, suffix="") as path:
            digest = await asyncio.to_thread(lambda: hashlib.sha256(path.read_bytes()).hexdigest())
            known = cache.get(digest)
            if known is not None:
                return known
            info = await asyncio.to_thread(inspect_font, path)
            if len(cache) >= 32:
                del cache[next(iter(cache))]
            cache[digest] = info
            return info

    return probe


__all__ = ["brand_template_facts", "template_font_prober", "template_video_prober"]
