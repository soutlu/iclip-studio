"""查一批图片地址现在能不能用：链接能打开，且是图片。制作页在用到图片的那一步查。

同一批里一个地址只查一次、只看响应头，几个地址同时探，探不通的隔一会儿再探一次。不行的原因只有两种：
打不开，或不是图片；不说为什么打不开，不透露内网主机与端口的情况。
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Iterable
from typing import Final
from urllib.parse import urlsplit

from iclip.platform.outbound.guard import FetchFailed

UrlProber = Callable[[str], Awaitable[str | None]]
"""探一个地址，交回最终 200 响应的媒体类型，取不到抛 ``FetchFailed``；组合根接 ``PublicFetcher.probe``。"""

PROBE_TIMEOUT_SECONDS: Final = 10.0
"""探一次地址的总时长上限；只看响应头，比下载短得多。"""

RETRY_DELAY_SECONDS: Final = 1.0
"""第一次探不通时，隔多久再探一次。"""

MAX_CONCURRENT_PROBES: Final = 4
"""同一批里最多同时探几个地址。"""

_EXTENSIONS: Final = frozenset({"jpg", "jpeg", "png", "webp", "gif"})
"""对方没说类型或只说是二进制流时，按地址路径的扩展名认。"""

_UNTYPED: Final = frozenset({"application/octet-stream", "binary/octet-stream"})


async def bad_images(probe: UrlProber, urls: Iterable[str]) -> dict[str, str]:
    """``urls`` 里不能用的地址到原因（「打不开」或「不是图片」）；都能用时为空。同一个地址只探一次。"""

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
    except ValueError:  # 方括号不配对之类的畸形 netloc，urlsplit 直接抛
        return "打不开"
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return "打不开"
    try:
        media_type = await _probe_twice(probe, url)
    except (FetchFailed, TimeoutError):
        return "打不开"
    return None if _is_image(url, media_type) else "不是图片"


async def _probe_twice(probe: UrlProber, url: str) -> str | None:
    """探不通就隔 ``RETRY_DELAY_SECONDS`` 再探一次，不分是什么失败；第二次也不通才往外抛。"""

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
