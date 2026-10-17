from __future__ import annotations

import asyncio
import uuid
from collections.abc import Callable

import httpx

from iclip.domains.brand_templates.models import ProbedVideo
from iclip.domains.brand_templates.repository import BrandTemplateStore, ProbeVideo
from iclip.domains.generation.ports import BrandTemplateFacts, BrandTemplates
from iclip.platform.media.fetch import MAX_VIDEO_BYTES, fetched
from iclip.platform.media.fonts import MAX_FONT_BYTES, FontInfo, ProbeFont, inspect_font
from iclip.platform.media.probe import probe_duration_ms, probe_video


def template_video_prober(client: httpx.AsyncClient, fetch_url: Callable[[str], str]) -> ProbeVideo:
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
    async def facts(template_id: uuid.UUID) -> BrandTemplateFacts | None:
        template = await store.get(template_id)
        if template is None:
            return None
        return BrandTemplateFacts(
            id=template.id,
            kind=template.kind,
            name=template.name,
            enabled=template.disabled_at is None,
            url=template.url,
            duration_ms=template.duration_ms,
            width=template.width,
            height=template.height,
            has_audio=template.has_audio,
        )

    return facts


def template_font_prober(client: httpx.AsyncClient, fetch_url: Callable[[str], str]) -> ProbeFont:
    async def probe(url: str) -> FontInfo:
        async with fetched(client, fetch_url(url), max_bytes=MAX_FONT_BYTES, suffix="") as path:
            return await asyncio.to_thread(inspect_font, path)

    return probe


__all__ = ["brand_template_facts", "template_font_prober", "template_video_prober"]
