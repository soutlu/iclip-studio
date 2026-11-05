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
from mcp.types import ToolAnnotations
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

TOKEN: Final = "Bearer mcp-test-token-0123456789"

TOOLS: Final = ("add", "shout", "divide")

TITLES: Final = {"add": "加法", "shout": "转大写", "divide": None}


@dataclass
class LocalMcp:
    http_url: str
    sse_url: str
    calls: list[tuple[str, dict[str, Any]]] = field(
        default_factory=list[tuple[str, dict[str, Any]]]
    )


class _RequireToken:
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
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def _server(local: LocalMcp) -> MCPServer:
    server = MCPServer("calc")

    @server.tool(title=TITLES["add"])
    def add(a: int, b: int) -> int:
        """Add two integers."""
        local.calls.append(("add", {"a": a, "b": b}))
        return a + b

    @server.tool(annotations=ToolAnnotations(title=TITLES["shout"]))
    def shout(text: str) -> str:
        """Upper-case the text."""
        local.calls.append(("shout", {"text": text}))
        return text.upper()

    @server.tool()
    def divide(a: float, b: float) -> float:
        """Divide a by b."""
        local.calls.append(("divide", {"a": a, "b": b}))
        if b == 0:
            raise ToolError("cannot divide by zero")
        return a / b

    _ = (add, shout, divide)
    return server


@asynccontextmanager
async def local_mcp() -> AsyncGenerator[LocalMcp]:
    http_port, sse_port = free_port(), free_port()
    local = LocalMcp(
        http_url=f"http://127.0.0.1:{http_port}/mcp", sse_url=f"http://127.0.0.1:{sse_port}/sse"
    )
    http_app = _server(local).streamable_http_app()
    sse_app = _server(local).sse_app()
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
