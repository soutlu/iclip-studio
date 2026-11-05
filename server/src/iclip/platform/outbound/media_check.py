from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Iterable
from typing import Final
from urllib.parse import urlsplit

from iclip.platform.outbound.guard import FetchFailed

UrlProber = Callable[[str], Awaitable[str | None]]

PROBE_TIMEOUT_SECONDS: Final = 10.0

RETRY_DELAY_SECONDS: Final = 1.0

MAX_CONCURRENT_PROBES: Final = 4

_EXTENSIONS: Final = frozenset({"jpg", "jpeg", "png", "webp", "gif"})

_UNTYPED: Final = frozenset({"application/octet-stream", "binary/octet-stream"})


async def bad_images(probe: UrlProber, urls: Iterable[str]) -> dict[str, str]:
    unique = list(dict.fromkeys(urls))
    gate = asyncio.Semaphore(MAX_CONCURRENT_PROBES)

    async def one(url: str) -> str | None:
        async with gate:
            return await _problem(probe, url)

    reasons = await asyncio.gather(*(one(url) for url in unique))
    return {url: reason for url, reason in zip(unique, reasons, strict=True) if reason is not None}


async def _problem(probe: UrlProber, url: str) -> str | None:
    try:
        parts = urlsplit(url)
    except ValueError:
        return "打不开"
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return "打不开"
    try:
        media_type = await _probe_twice(probe, url)
    except (FetchFailed, TimeoutError):
        return "打不开"
    return None if _is_image(url, media_type) else "不是图片"


async def _probe_twice(probe: UrlProber, url: str) -> str | None:
    try:
        return await _probe_once(probe, url)
    except (FetchFailed, TimeoutError):
        await asyncio.sleep(RETRY_DELAY_SECONDS)
        return await _probe_once(probe, url)


async def _probe_once(probe: UrlProber, url: str) -> str | None:
    async with asyncio.timeout(PROBE_TIMEOUT_SECONDS):
        return await probe(url)


def _is_image(url: str, media_type: str | None) -> bool:
    if media_type is not None and media_type not in _UNTYPED:
        return media_type.startswith("image/")
    name = urlsplit(url).path.rsplit("/", 1)[-1]
    extension = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    return extension in _EXTENSIONS


__all__ = [
    "MAX_CONCURRENT_PROBES",
    "PROBE_TIMEOUT_SECONDS",
    "RETRY_DELAY_SECONDS",
    "UrlProber",
    "bad_images",
]
