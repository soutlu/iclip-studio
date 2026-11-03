"""出网规则：只连公网地址的 80 / 443，不带用户名密码，不走代理；建在 httpx-secure 上。

httpx-secure 在建连接时自己选 IP、查过再连，域名换成内网地址（DNS 重绑定）也连不过去，跳转后的新连接
照样查。这里给它配规则，每个请求发出前先拒掉它不管的地址里的用户名密码、以及不允许的端口（它查端口在
按主机名连过一次 TCP 之后）。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final

import httpx
from httpx_secure import httpx_ssrf_protection

MAX_REDIRECTS: Final = 3
"""最多跟几跳；每一跳的新连接都按同一套规则查。"""

_DEFAULT_PORTS: Final = {"http": 80, "https": 443}
"""地址没写端口时用的；别的协议 httpx 发请求前自己拒（``UnsupportedProtocol``）。"""


class FetchFailed(Exception):
    """出网请求没成：地址被拒、连不上、对方回的不是 200、超时等，不细分。"""


@dataclass(frozen=True, slots=True)
class OutboundPolicy:
    """允许连的端口与 IP。生产只用 ``PUBLIC_INTERNET``；测试用放行回环与本地端口的那份连本地服务器。"""

    ports: frozenset[int]
    loopback: bool = False
    """放行回环地址而不查公网；只给测试。"""


PUBLIC_INTERNET: Final = OutboundPolicy(ports=frozenset({80, 443}))
"""生产策略：只连公网地址的 80 / 443。"""


def public_client(*, timeout: float, policy: OutboundPolicy = PUBLIC_INTERNET) -> httpx.AsyncClient:
    """只连得到公网的 httpx 客户端，调用方持有、用完 ``aclose``（或 ``async with``）。

    不读代理环境变量（走代理就绕过了 IP 检查），跟跳转最多 ``MAX_REDIRECTS`` 跳；每个请求（含跳转后的）
    发出前拒掉带用户名密码或端口不在 ``policy.ports`` 里的地址（抛 ``FetchFailed``，不连对方）。
    ``timeout`` 是单步等待的上限。"""

    async def refuse_before_connecting(request: httpx.Request) -> None:
        url = request.url
        if url.userinfo:
            raise FetchFailed("地址里不能带用户名密码")
        # httpx-secure 先按主机名连一次 TCP 选 IP，之后才查端口；端口不对在这里就拒，不去连。
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
