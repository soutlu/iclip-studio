"""带出网防护的下载器：组合根建一个、lifespan 里关掉，调用方按地址取字节。"""

from __future__ import annotations

import asyncio
from typing import Final

import httpcore
import httpx

from iclip.platform.outbound.guard import (
    PUBLIC_INTERNET,
    FetchFailed,
    FetchRefused,
    GuardedBackend,
    OutboundPolicy,
    Resolve,
    check_url,
    system_resolve,
)

MAX_REDIRECTS: Final = 3
"""最多跟几跳；每一跳都重新按规则查。"""

TOTAL_TIMEOUT_SECONDS: Final = 30.0
"""一次下载从第一跳到读完的总时长上限。"""


class FetchTooLarge(FetchFailed):
    """响应超过调用方给的大小上限：``Content-Length`` 预检或边读边数时发现。"""


class _GuardedTransport(httpx.AsyncHTTPTransport):
    """连接走 ``GuardedBackend`` 的 httpx transport。

    ``AsyncHTTPTransport`` 不收 network backend，这里在父类建好之后把它的连接池换成带后端的
    ``httpcore.AsyncConnectionPool``：请求换成 httpcore 的形状、httpcore 异常映射成 httpx 异常、
    响应流的包装都照用父类的。另一种做法是自己写 ``AsyncBaseTransport`` 包连接池，那样就得
    import httpx 私有模块里的异常映射与响应流（strict pyright 不许），或者照抄一遍；换池子只碰
    一个子类可见的属性。父类建的那个池子还没开过任何连接，直接丢掉。
    """

    def __init__(self, backend: httpcore.AsyncNetworkBackend) -> None:
        super().__init__(trust_env=False)
        self._pool = httpcore.AsyncConnectionPool(
            ssl_context=httpx.create_ssl_context(trust_env=False),
            network_backend=backend,
            http1=True,
            http2=False,
        )


class PublicFetcher:
    """只连得到公网的下载器，自己持有一个 httpx 客户端，用完调 ``aclose``。

    规则写死在 ``PUBLIC_INTERNET``：http/https、80/443、不带用户名密码、解析出的每个 IP 都是
    公网地址，连接只用查过的 IP；不读代理环境变量（走代理就绕过了 IP 检查）；跳转手动跟，最多
    ``MAX_REDIRECTS`` 跳，每跳重查。``policy``、``resolve``、``network_backend`` 只给测试注入。
    """

    def __init__(
        self,
        *,
        policy: OutboundPolicy = PUBLIC_INTERNET,
        resolve: Resolve = system_resolve,
        network_backend: httpcore.AsyncNetworkBackend | None = None,
        total_timeout_seconds: float = TOTAL_TIMEOUT_SECONDS,
    ) -> None:
        self._policy = policy
        self._total_timeout = total_timeout_seconds
        backend = GuardedBackend(policy, resolve=resolve, delegate=network_backend)
        self._client = httpx.AsyncClient(
            transport=_GuardedTransport(backend),
            # 不读 HTTP(S)_PROXY：代理会被挂成优先于 transport 的出口。
            trust_env=False,
            follow_redirects=False,
            # 单步等待不超过总时长；总时长由 fetch 里的 asyncio.timeout 管。
            timeout=httpx.Timeout(total_timeout_seconds),
        )

    async def fetch(self, url: str, *, max_bytes: int) -> bytes:
        """下载 ``url`` 的响应体，交回字节。只收最终 200 的响应。

        地址或 IP 不合规则抛 ``FetchRefused``（没有建连接），超过 ``max_bytes`` 抛
        ``FetchTooLarge``，其余失败（连不上、对方回错、跳转太多、超时）抛 ``FetchFailed``。"""

        try:
            async with asyncio.timeout(self._total_timeout):
                return await self._follow(httpx.URL(url), max_bytes=max_bytes)
        except TimeoutError as exc:
            raise FetchFailed(f"{self._total_timeout:g} 秒内没有下载完") from exc
        except httpx.InvalidURL as exc:
            raise FetchRefused(f"地址格式不对：{exc}") from exc
        except httpx.HTTPError as exc:
            raise FetchFailed(f"下载出错：{str(exc) or type(exc).__name__}") from exc

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _follow(self, url: httpx.URL, *, max_bytes: int) -> bytes:
        for _ in range(MAX_REDIRECTS + 1):
            check_url(url, self._policy)
            async with self._client.stream("GET", url) as response:
                if response.is_redirect:
                    url = url.join(response.headers["location"])
                    continue
                if response.status_code != 200:
                    raise FetchFailed(f"对方回了 {response.status_code}")
                return await _read_capped(response, max_bytes=max_bytes)
        raise FetchFailed(f"跳转超过 {MAX_REDIRECTS} 次")


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


__all__ = ["MAX_REDIRECTS", "TOTAL_TIMEOUT_SECONDS", "FetchTooLarge", "PublicFetcher"]
