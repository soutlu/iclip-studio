"""只连公网的下载器：按地址取字节（消息附件转存）或只看响应头探类型（制作页的地址检查）。"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Final

import httpx

from iclip.platform.outbound.guard import (
    PUBLIC_INTERNET,
    FetchFailed,
    OutboundPolicy,
    failure_of,
    public_client,
)

TOTAL_TIMEOUT_SECONDS: Final = 30.0
"""一次请求从第一跳到读完的总时长上限，也是单步等待的上限。"""


class FetchTooLarge(FetchFailed):
    """响应超过调用方给的大小上限：``Content-Length`` 预检或边读边数时发现。"""


class PublicFetcher:
    """只连得到公网的下载器，自己持有一个 ``public_client``，组合根建好、lifespan 里 ``aclose``。

    超过大小上限抛 ``FetchTooLarge``，其余失败（地址被拒、格式不对、连不上、最终不是 200、跳转太多、超时）
    抛 ``FetchFailed``，原因在消息里。``policy`` 只给测试换成放行回环的那份。"""

    def __init__(
        self,
        *,
        policy: OutboundPolicy = PUBLIC_INTERNET,
        total_timeout_seconds: float = TOTAL_TIMEOUT_SECONDS,
    ) -> None:
        self._total_timeout = total_timeout_seconds
        self._client = public_client(timeout=total_timeout_seconds, policy=policy)

    async def fetch(self, url: str, *, max_bytes: int) -> bytes:
        """下载 ``url`` 的响应体，交回字节。"""

        async def read(response: httpx.Response) -> bytes:
            return await _read_capped(response, max_bytes=max_bytes)

        return await self._on_final(url, read)

    async def probe(self, url: str) -> str | None:
        """确认 ``url`` 现在取得到：GET（有的站不收 HEAD）跟到最终 200，只看响应头、不读响应体。

        交回 ``Content-Type`` 去掉参数、转小写；对方没给时为 None。"""

        async def look(response: httpx.Response) -> str | None:
            media_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
            return media_type or None

        return await self._on_final(url, look)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _on_final[T](self, url: str, use: Callable[[httpx.Response], Awaitable[T]]) -> T:
        try:
            async with asyncio.timeout(self._total_timeout):
                async with self._client.stream("GET", url) as response:
                    if response.status_code != 200:
                        raise FetchFailed(f"对方回了 {response.status_code}")
                    return await use(response)
        except TimeoutError as exc:
            raise FetchFailed(f"{self._total_timeout:g} 秒内没有完成") from exc
        except (httpx.HTTPError, httpx.InvalidURL, UnicodeError) as exc:
            raise failure_of(exc) from exc


async def _read_capped(response: httpx.Response, *, max_bytes: int) -> bytes:
    """先看 ``Content-Length``，再边读边数（解压后的字节），超过上限立刻停。"""

    declared = response.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > max_bytes:
        raise FetchTooLarge(f"文件有 {int(declared)} 字节，超过 {max_bytes} 字节的上限")
    body = bytearray()
    async for chunk in response.aiter_bytes():
        body += chunk
        if len(body) > max_bytes:
            raise FetchTooLarge(f"读到超过 {max_bytes} 字节还没完，超过上限")
    return bytes(body)


__all__ = ["TOTAL_TIMEOUT_SECONDS", "FetchTooLarge", "PublicFetcher"]
