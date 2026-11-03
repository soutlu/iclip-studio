"""探一个地址：GET 跟到最终 200，只看响应头、不读响应体，交回媒体类型。"""

from __future__ import annotations

import httpx

from agent_runtime.outbound.guard import FetchFailed


async def probe(client: httpx.AsyncClient, url: str) -> str | None:
    """用 ``client``（``guard.public_client`` 建的）确认 ``url`` 现在取得到。用 GET：有的站不收 HEAD。

    交回最终 200 响应的 ``Content-Type``（去掉参数、转小写；对方没给时为 None）。取不到一律抛
    ``FetchFailed``：地址被拒、格式不对、连不上、跳转太多、最终不是 200。"""

    try:
        async with client.stream("GET", url) as response:
            if response.status_code != 200:
                raise FetchFailed(f"对方回了 {response.status_code}")
            media_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
            return media_type or None
    # 认不了的地址抛 InvalidURL，主机名不是合法 IDNA 时抛 UnicodeError，两者都不是 HTTPError。
    except (httpx.HTTPError, httpx.InvalidURL, UnicodeError) as exc:
        raise FetchFailed(str(exc) or type(exc).__name__) from exc


__all__ = ["probe"]
