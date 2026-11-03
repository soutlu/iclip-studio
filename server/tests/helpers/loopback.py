"""本机回环上的小 HTTP 服务器：按路径答预设的状态、响应头与响应体，给出网防护的行为测试用。

不连外网。连它要用放行回环与它那个端口的策略（``loopback_policy``）；默认的公网策略连它就该被拒。
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator, Mapping
from contextlib import asynccontextmanager
from dataclasses import dataclass, field

from iclip.platform.outbound.guard import OutboundPolicy


@dataclass(frozen=True, slots=True)
class Route:
    status: str = "200 OK"
    headers: Mapping[str, str] = field(default_factory=dict[str, str])
    body: bytes = b""
    stall_before_head: bool = False
    """收到请求后不答，等客户端超时。"""

    stall_after_head: bool = False
    """答完响应头就停，响应体一直不来：读响应体的客户端会卡住。"""

    declare_length: bool = True
    """不写 ``Content-Length`` 时响应体读到连接关闭为止。"""


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
            headers = dict(route.headers)
            if route.declare_length:
                headers.setdefault("Content-Length", str(len(route.body)))
            lines += [f"{name}: {value}" for name, value in headers.items()]
            writer.write(("\r\n".join(lines) + "\r\n\r\n").encode())
            await writer.drain()
            if route.stall_after_head:
                await asyncio.sleep(30)
            writer.write(route.body)
            await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionError):
            # 客户端先断开（超时、只看响应头、超过大小上限）是这些用例的常态。
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


def loopback_policy(server: LoopbackServer) -> OutboundPolicy:
    """放行回环与这台服务器端口的策略；其余规则（跳转、用户名密码、代理）同生产。"""

    return OutboundPolicy(ports=frozenset({server.port}), loopback=True)


__all__ = ["LoopbackServer", "Route", "loopback_policy", "loopback_server"]
