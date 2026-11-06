from __future__ import annotations

import httpx

from agent_runtime.outbound.guard import FetchFailed


async def probe(client: httpx.AsyncClient, url: str) -> str | None:
    try:
        async with client.stream("GET", url) as response:
            if response.status_code != 200:
                raise FetchFailed(f"对方回了 {response.status_code}")
            media_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
            return media_type or None
    except (httpx.HTTPError, httpx.InvalidURL, UnicodeError) as exc:
        raise FetchFailed(str(exc) or type(exc).__name__) from exc


__all__ = ["probe"]
