"""本机回环上的小 HTTP 服务器：按路径答预设的状态与响应头，给出网防护与地址检查的行为测试用。

不连外网。连它的客户端要用放行回环与它那个端口的策略（``loopback_client``）；默认的公网策略连它就该被拒。
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator, Mapping
from contextlib import asynccontextmanager
from dataclasses import dataclass, field

import httpx
import pytest

from agent_runtime.outbound.guard import OutboundPolicy, public_client


@dataclass(frozen=True, slots=True)
class Route:
    status: str = "200 OK"
    headers: Mapping[str, str] = field(default_factory=dict[str, str])
    body: bytes = b""
    stall_before_head: bool = False
    """收到请求后不答，等客户端超时。"""

    stall_after_head: bool = False
    """答完响应头就停，响应体一直不来：读响应体的客户端会卡住。"""


@dataclass
class LoopbackServer:
    routes: dict[str, Route]
    port: int = 0
    paths: list[str] = field(default_factory=list[str])
    """收到的请求路径，按先后。"""

    connections: int = 0
    """接进来的 TCP 连接数，没发请求就断开的也算。"""

    def url(self, path: str, *, host: str = "127.0.0.1") -> str:
        return f"http://{host}:{self.port}{path}"

    async def serve(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        """``asyncio.start_server`` 的连接回调：读一个请求，按路由答。"""

        self.connections += 1
        try:
            head = await reader.readuntil(b"\r\n\r\n")
            path = head.split(b" ", 2)[1].decode()
            self.paths.append(path)
            route = self.routes.get(path.split("?", 1)[0], Route(status="404 Not Found"))
            if route.stall_before_head:
                await asyncio.sleep(30)
            lines = [f"HTTP/1.1 {route.status}", "Connection: close"]
            headers = {"Content-Length": str(len(route.body)), **route.headers}
            lines += [f"{name}: {value}" for name, value in headers.items()]
            writer.write(("\r\n".join(lines) + "\r\n\r\n").encode())
            await writer.drain()
            if route.stall_after_head:
                await asyncio.sleep(30)
            writer.write(route.body)
            await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionError):
            # 客户端先断开（超时、只看响应头）是这些用例的常态。
            return
        finally:
            writer.close()


@asynccontextmanager
async def loopback_server(routes: dict[str, Route]) -> AsyncGenerator[LoopbackServer]:
    server = LoopbackServer(routes)
    listening = await asyncio.start_server(server.serve, "127.0.0.1", 0)
    server.port = listening.sockets[0].getsockname()[1]
    try:
        yield server
    finally:
        listening.close()
        listening.close_clients()
        await listening.wait_closed()


def loopback_client(server: LoopbackServer, *, timeout: float = 2.0) -> httpx.AsyncClient:
    """放行回环与这台服务器端口的受保护客户端；其余规则（跳转、用户名密码、代理）同生产。"""

    return public_client(
        timeout=timeout, policy=OutboundPolicy(ports=frozenset({server.port}), loopback=True)
    )


def checks_reach(
    server: LoopbackServer, monkeypatch: pytest.MonkeyPatch, *, timeout: float = 2.0
) -> None:
    """让提交点的地址检查连得上这台服务器：把检查每次自己建的 ``public_client`` 换成 ``loopback_client``。

    检查给的单步时长不用，改用 ``timeout``：卡住的路由按测试给的短时长超时，不等检查自己的上限。"""

    def build(**_: object) -> httpx.AsyncClient:
        return loopback_client(server, timeout=timeout)

    monkeypatch.setattr("agent_runtime.harness.media_check.public_client", build)


__all__ = ["LoopbackServer", "Route", "checks_reach", "loopback_client", "loopback_server"]
