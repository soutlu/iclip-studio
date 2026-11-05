from __future__ import annotations

from dataclasses import dataclass
from typing import Final

import httpx
from httpx_secure import SSRFProtectionError, httpx_ssrf_protection

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
        # httpx-secure 先发起 TCP 连接选择 IP 后才校验端口，需在连接前拦截非标准端口。
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


def failure_of(exc: httpx.HTTPError | httpx.InvalidURL | UnicodeError) -> FetchFailed:
    if isinstance(exc, SSRFProtectionError):
        return FetchFailed(
            f"{exc.hostname} 连到的 {exc.ip_addr}:{exc.port} 不是允许的公网地址与端口"
        )
    if isinstance(exc, httpx.UnsupportedProtocol | httpx.InvalidURL | UnicodeError):
        return FetchFailed(f"地址格式不对：{exc}")
    return FetchFailed(f"下载出错：{type(exc).__name__}")


__all__ = [
    "MAX_REDIRECTS",
    "PUBLIC_INTERNET",
    "FetchFailed",
    "OutboundPolicy",
    "failure_of",
    "public_client",
]
