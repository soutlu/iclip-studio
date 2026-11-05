from __future__ import annotations

import asyncio
from collections.abc import Iterable
from typing import Final, Literal
from urllib.parse import urlsplit

import httpx

from agent_runtime.outbound.guard import FetchFailed, public_client
from agent_runtime.outbound.probe import probe
from agent_runtime.urls import is_http_url

MediaKind = Literal["image", "video"]

CHECK_TIMEOUT_SECONDS: Final = 10.0

RETRY_DELAY_SECONDS: Final = 1.0

MAX_CONCURRENT_PROBES: Final = 4

_UNREACHABLE: Final = "打不开"

_WRONG_KIND: Final[dict[MediaKind, str]] = {"image": "不是图片", "video": "不是视频"}

_EXTENSIONS: Final[dict[MediaKind, frozenset[str]]] = {
    "image": frozenset({"jpg", "jpeg", "png", "webp", "gif"}),
    "video": frozenset({"mp4", "mov", "webm", "m4v"}),
}

_UNTYPED: Final = frozenset({"application/octet-stream", "binary/octet-stream"})


async def bad_urls(urls: Iterable[str], *, kind: MediaKind) -> dict[str, str]:
    unique = list(dict.fromkeys(urls))
    if not unique:
        return {}
    gate = asyncio.Semaphore(MAX_CONCURRENT_PROBES)
    async with public_client(timeout=CHECK_TIMEOUT_SECONDS) as client:

        async def one(url: str) -> str | None:
            async with gate:
                return await _problem(client, url, kind)

        reasons = await asyncio.gather(*(one(url) for url in unique))
    return {url: reason for url, reason in zip(unique, reasons, strict=True) if reason is not None}


async def _problem(client: httpx.AsyncClient, url: str, kind: MediaKind) -> str | None:
    if not is_http_url(url):
        return _UNREACHABLE
    try:
        media_type = await _probe_twice(client, url)
    except (FetchFailed, TimeoutError):
        return _UNREACHABLE
    return None if _is_kind(url, media_type, kind) else _WRONG_KIND[kind]


async def _probe_twice(client: httpx.AsyncClient, url: str) -> str | None:
    try:
        return await _probe_once(client, url)
    except (FetchFailed, TimeoutError):
        await asyncio.sleep(RETRY_DELAY_SECONDS)
        return await _probe_once(client, url)


async def _probe_once(client: httpx.AsyncClient, url: str) -> str | None:
    async with asyncio.timeout(CHECK_TIMEOUT_SECONDS):
        return await probe(client, url)


def _is_kind(url: str, media_type: str | None, kind: MediaKind) -> bool:
    if media_type is not None and media_type not in _UNTYPED:
        return media_type.startswith(f"{kind}/")
    name = urlsplit(url).path.rsplit("/", 1)[-1]
    extension = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    return extension in _EXTENSIONS[kind]


__all__ = [
    "CHECK_TIMEOUT_SECONDS",
    "MAX_CONCURRENT_PROBES",
    "RETRY_DELAY_SECONDS",
    "MediaKind",
    "bad_urls",
]
