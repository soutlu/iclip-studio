"""出网规则：地址形状、端口与解析出的 IP。

``check_url`` 在发请求之前查地址本身；``GuardedBackend`` 在建连接那一刻自己解析域名、查每个 IP，
再拿查过的 IP 去连。DNS 由我们自己解析、连的就是查过的那个 IP，域名在两次解析之间换成内网地址
（DNS 重绑定）也连不过去。TLS 握手由 httpcore 按原主机名调 ``start_tls``，SNI 与证书校验不受影响。
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from collections.abc import Awaitable, Callable, Iterable, Sequence
from dataclasses import dataclass
from typing import Any, Final

import httpcore
import httpx

IpAddress = ipaddress.IPv4Address | ipaddress.IPv6Address

Resolve = Callable[[str, int], Awaitable[Sequence[str]]]
"""把（主机名，端口）解析成 IP 文本；生产用系统解析，测试注入假的。"""


class FetchFailed(Exception):
    """出网下载没拿到字节：地址被拒、连不上、对方回了错误、超时或超过大小上限。"""


class FetchRefused(FetchFailed):
    """地址或它解析出的 IP 不合规则，没有建立任何连接。"""


@dataclass(frozen=True, slots=True)
class OutboundPolicy:
    """允许连的端口与 IP。生产只用 ``PUBLIC_INTERNET``；测试注入放行回环的那份连本地服务器。"""

    ports: frozenset[int]
    address_allowed: Callable[[IpAddress], bool]


def is_public_address(address: IpAddress) -> bool:
    """公网地址才放行。IPv4-mapped 的 IPv6（``::ffff:10.0.0.1``）先拆成 IPv4 再判，否则内网地址
    换个写法就能混过去。"""

    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        address = address.ipv4_mapped
    return address.is_global


PUBLIC_INTERNET: Final = OutboundPolicy(
    ports=frozenset({80, 443}), address_allowed=is_public_address
)
"""生产策略：只连公网地址的 80 / 443。"""

_SCHEMES: Final = frozenset({"http", "https"})


def check_url(url: httpx.URL, policy: OutboundPolicy) -> None:
    """发请求之前查地址：scheme 只收 http/https，端口在策略里，不带用户名密码。不合规则抛
    ``FetchRefused``。IP 在建连接时由 ``GuardedBackend`` 查。"""

    if url.scheme not in _SCHEMES:
        raise FetchRefused(f"只下载 http/https 地址，这个是 {url.scheme or '空'}")
    if not url.host:
        raise FetchRefused("地址里没有主机名")
    if url.userinfo:
        raise FetchRefused("地址里不能带用户名密码")
    port = url.port if url.port is not None else (443 if url.scheme == "https" else 80)
    if port not in policy.ports:
        raise FetchRefused(f"不连 {port} 端口")


async def system_resolve(host: str, port: int) -> Sequence[str]:
    """用事件循环的 getaddrinfo（在线程里跑，不阻塞循环）解析出全部 IP。"""

    infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return [str(info[4][0]) for info in infos]


class GuardedBackend(httpcore.AsyncNetworkBackend):
    """httpcore 的网络后端：建 TCP 连接前自己解析、逐个查 IP，有一个不合规则就整体拒绝，
    全部合格才拿这些 IP 依次去连。真正的收发交给 ``delegate``（默认 anyio）。"""

    def __init__(
        self,
        policy: OutboundPolicy,
        *,
        resolve: Resolve = system_resolve,
        delegate: httpcore.AsyncNetworkBackend | None = None,
    ) -> None:
        self._policy = policy
        self._resolve = resolve
        self._delegate = delegate if delegate is not None else _anyio_backend()

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Iterable[Any] | None = None,
    ) -> httpcore.AsyncNetworkStream:
        # check_url 已经查过端口；这里再查一遍，后端单独用时规则也成立。
        if port not in self._policy.ports:
            raise FetchRefused(f"不连 {port} 端口")
        # 一个地址连不上换下一个，都连不上抛最后那次的错。
        failure: Exception = FetchFailed(f"{host} 没有可连的地址")
        for address in await self._vetted(host, port):
            try:
                return await self._delegate.connect_tcp(
                    str(address),
                    port,
                    timeout=timeout,
                    local_address=local_address,
                    socket_options=socket_options,
                )
            except (httpcore.ConnectError, httpcore.ConnectTimeout) as exc:
                failure = exc
        raise failure

    async def connect_unix_socket(
        self,
        path: str,
        timeout: float | None = None,
        socket_options: Iterable[Any] | None = None,
    ) -> httpcore.AsyncNetworkStream:
        raise FetchRefused("不连本机 socket")

    async def sleep(self, seconds: float) -> None:
        await self._delegate.sleep(seconds)

    async def _vetted(self, host: str, port: int) -> tuple[IpAddress, ...]:
        """解析并查全部 IP，去重保序；解析失败、没有地址或有一个不合规则都抛错。"""

        try:
            resolved = await self._resolve(host, port)
        except OSError as exc:
            raise FetchFailed(f"解析不了 {host}：{exc}") from exc
        addresses: list[IpAddress] = []
        for text in resolved:
            try:
                address = ipaddress.ip_address(text)
            except ValueError as exc:
                raise FetchRefused(f"{host} 解析出的 {text} 不是 IP") from exc
            if not self._policy.address_allowed(address):
                raise FetchRefused(f"{host} 解析到了非公网地址 {address}")
            if address not in addresses:
                addresses.append(address)
        if not addresses:
            raise FetchFailed(f"{host} 没有解析出地址")
        return tuple(addresses)


def _anyio_backend() -> httpcore.AsyncNetworkBackend:
    """httpcore 的 anyio 后端。httpcore 在没装 anyio 时导出一个同名的占位类，类型检查只看得见
    占位类，这里按实际类型收窄。"""

    backend = httpcore.AnyIOBackend()
    if not isinstance(backend, httpcore.AsyncNetworkBackend):
        raise RuntimeError("httpcore.AnyIOBackend 不是网络后端，anyio 没装上")
    return backend


__all__ = [
    "PUBLIC_INTERNET",
    "FetchFailed",
    "FetchRefused",
    "GuardedBackend",
    "IpAddress",
    "OutboundPolicy",
    "Resolve",
    "check_url",
    "is_public_address",
    "system_resolve",
]
