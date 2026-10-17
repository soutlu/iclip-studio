from __future__ import annotations

import asyncio
from collections.abc import Callable

import httpx

from iclip.platform.media.fetch import fetched
from iclip.platform.media.fonts import MAX_FONT_BYTES, FontInfo, ProbeFont, inspect_font


def template_font_prober(client: httpx.AsyncClient, fetch_url: Callable[[str], str]) -> ProbeFont:
    async def probe(url: str) -> FontInfo:
        async with fetched(client, fetch_url(url), max_bytes=MAX_FONT_BYTES, suffix="") as path:
            return await asyncio.to_thread(inspect_font, path)

    return probe


__all__ = ["template_font_prober"]
