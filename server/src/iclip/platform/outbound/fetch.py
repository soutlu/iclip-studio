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


class FetchTooLarge(FetchFailed):
    pass


class PublicFetcher:
    def __init__(
        self,
        *,
        policy: OutboundPolicy = PUBLIC_INTERNET,
        total_timeout_seconds: float = TOTAL_TIMEOUT_SECONDS,
    ) -> None:
        self._total_timeout = total_timeout_seconds
        self._client = public_client(timeout=total_timeout_seconds, policy=policy)

    async def fetch(self, url: str, *, max_bytes: int) -> bytes:
        async def read(response: httpx.Response) -> bytes:
            return await _read_capped(response, max_bytes=max_bytes)

        return await self._on_final(url, read)

    async def probe(self, url: str) -> str | None:
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
