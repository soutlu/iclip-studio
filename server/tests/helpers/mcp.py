"""集成测试用的本地 MCP 服务：用官方 MCP SDK 的服务端在进程里起两个 uvicorn，只监听 127.0.0.1，不出网。

一个走 Streamable HTTP（``…/mcp``），一个走 SSE（``…/sse``），同一组工具：``add``、``shout``、``divide``
（除以 0 时报错）。两个都要求 ``Authorization: Bearer <TOKEN>``，不对答 401。``calls`` 记下服务端真收到的
每次工具调用。"""

from __future__ import annotations

import asyncio
import socket
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any, Final

import uvicorn
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

TOKEN: Final = "Bearer mcp-test-token-0123456789"
"""本地 MCP 服务认的请求头值；测试检查它从不以明文出现在答复里。"""

TOOLS: Final = ("add", "shout", "divide")


@dataclass
class LocalMcp:
    http_url: str
    sse_url: str
    calls: list[tuple[str, dict[str, Any]]] = field(
        default_factory=list[tuple[str, dict[str, Any]]]
    )


class _RequireToken:
    """纯 ASGI 的鉴权：SSE 的长连接经不起 ``BaseHTTPMiddleware``。"""

    def __init__(self, app: ASGIApp) -> None:
        self._app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and dict(scope["headers"]).get(b"authorization") != (
            TOKEN.encode()
        ):
            await JSONResponse({"error": "unauthorized"}, status_code=401)(scope, receive, send)
            return
        await self._app(scope, receive, send)


def free_port() -> int:
    """一个此刻没人监听的本机端口；拿来当连不上的地址，或交给 uvicorn。"""

    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def _server(local: LocalMcp) -> MCPServer:
    server = MCPServer("calc")

    @server.tool()
    def add(a: int, b: int) -> int:
        """Add two integers."""
        local.calls.append(("add", {"a": a, "b": b}))
        return a + b

    @server.tool()
    def shout(text: str) -> str:
        """Upper-case the text."""
        local.calls.append(("shout", {"text": text}))
        return text.upper()

    @server.tool()
    def divide(a: float, b: float) -> float:
        """Divide a by b."""
        local.calls.append(("divide", {"a": a, "b": b}))
        if b == 0:
            # 工具自己报的错原话交给调用方；别的异常服务端只回一句笼统的话。
            raise ToolError("cannot divide by zero")
        return a / b

    _ = (add, shout, divide)
    return server


@asynccontextmanager
async def local_mcp() -> AsyncGenerator[LocalMcp]:
    """起两个服务，块结束时关掉。每次都建新的服务端：Streamable HTTP 的会话管理器只能跑一次。"""

    http_port, sse_port = free_port(), free_port()
    local = LocalMcp(
        http_url=f"http://127.0.0.1:{http_port}/mcp", sse_url=f"http://127.0.0.1:{sse_port}/sse"
    )
    http_app = _server(local).streamable_http_app()
    sse_app = _server(local).sse_app()
    # 不让 uvicorn 碰日志配置：``log_config``、``log_level`` 与 ``access_log=False`` 都会改写进程里 uvicorn
    # 那几个 logger，之后测日志的用例会被带偏。
    servers = [
        uvicorn.Server(
            uvicorn.Config(
                _RequireToken(app), host="127.0.0.1", port=port, log_config=None, log_level=None
            )
        )
        for app, port in ((http_app, http_port), (sse_app, sse_port))
    ]
    tasks = [asyncio.create_task(server.serve()) for server in servers]
    try:
        for _ in range(200):
            if all(server.started for server in servers):
                break
            await asyncio.sleep(0.02)
        else:
            raise AssertionError("本地 MCP 服务没起来")
        yield local
    finally:
        for server in servers:
            server.should_exit = True
        await asyncio.gather(*tasks)


__all__ = ["TOKEN", "TOOLS", "LocalMcp", "free_port", "local_mcp"]
