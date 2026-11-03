"""查一批媒体地址现在能不能用：链接能打开（经出网防护跟到最终 200），且是要的那种媒体。

只在提交点查（交付镜头表、检查工程、出图、拆解），读的时候不查。同一批里一个地址只查一次、只看响应头，
几个地址同时探，探不通的隔一会儿再探一次；每次检查自己建一个只连公网的客户端，查完就关。不行的原因只有
两种：打不开，或类型不对；不说为什么打不开，不透露内网主机与端口的情况。
"""

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
"""探一次地址的总时长上限；只看响应头，比下载短得多。"""

RETRY_DELAY_SECONDS: Final = 1.0
"""第一次探不通时，隔多久再探一次。"""

MAX_CONCURRENT_PROBES: Final = 4
"""同一批里最多同时探几个地址。"""

_UNREACHABLE: Final = "打不开"

_WRONG_KIND: Final[dict[MediaKind, str]] = {"image": "不是图片", "video": "不是视频"}

_EXTENSIONS: Final[dict[MediaKind, frozenset[str]]] = {
    "image": frozenset({"jpg", "jpeg", "png", "webp", "gif"}),
    "video": frozenset({"mp4", "mov", "webm", "m4v"}),
}
"""对方没说类型或只说是二进制流时，按地址路径的扩展名认。"""

_UNTYPED: Final = frozenset({"application/octet-stream", "binary/octet-stream"})


async def bad_urls(urls: Iterable[str], *, kind: MediaKind) -> dict[str, str]:
    """``urls`` 里不能用的地址到原因（「打不开」或「不是图片」「不是视频」）；都能用时为空。

    同一个地址只探一次。每次检查建一个 ``public_client``、查完关掉；没有地址时不建。"""

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
    """探不通就隔 ``RETRY_DELAY_SECONDS`` 再探一次，不分是什么失败；第二次也不通才往外抛。"""

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
