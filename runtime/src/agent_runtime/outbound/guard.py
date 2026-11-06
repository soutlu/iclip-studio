from __future__ import annotations

from dataclasses import dataclass
from typing import Final

import httpx
from httpx_secure import httpx_ssrf_protection

MAX_REDIRECTS: Final = 3

_DEFAULT_PORTS: Final = {"http": 80, "https": 443}


class FetchFailed(Exception):
    pass


@dataclass(frozen=True, slots=True)
class OutboundPolicy:
    ports: frozenset[int]
    loopback: bool = False


PUBLIC_INTERNET: Final = OutboundPolicy(ports=frozenset({80, 443}))


def public_client(*, timeout: float, policy: OutboundPolicy = PUBLIC_INTERNET) -> httpx.AsyncClient:
    async def refuse_before_connecting(request: httpx.Request) -> None:
        url = request.url
        if url.userinfo:
            raise FetchFailed("地址里不能带用户名密码")
        port = url.port or _DEFAULT_PORTS.get(url.scheme)
        if port is not None and port not in policy.ports:
            raise FetchFailed(f"不连 {port} 端口")

    client = httpx.AsyncClient(
        trust_env=False,
        follow_redirects=True,
        max_redirects=MAX_REDIRECTS,
        timeout=httpx.Timeout(timeout),
        event_hooks={"request": [refuse_before_connecting]},
    )
    if policy.loopback:
        return httpx_ssrf_protection(
            client,
            check_globally_reachable=False,
            custom_validator=lambda _host, ip, port: ip.is_loopback and port in policy.ports,
        )
    return httpx_ssrf_protection(
        client, custom_validator=lambda _host, _ip, port: port in policy.ports
    )


__all__ = ["MAX_REDIRECTS", "PUBLIC_INTERNET", "FetchFailed", "OutboundPolicy", "public_client"]
