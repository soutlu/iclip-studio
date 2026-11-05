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

    stall_after_head: bool = False


@dataclass
class LoopbackServer:
    routes: dict[str, Route]
    port: int = 0
    paths: list[str] = field(default_factory=list[str])

    connections: int = 0

    def url(self, path: str, *, host: str = "127.0.0.1") -> str:
        return f"http://{host}:{self.port}{path}"

    async def serve(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
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
    return public_client(
        timeout=timeout, policy=OutboundPolicy(ports=frozenset({server.port}), loopback=True)
    )


def checks_reach(
    server: LoopbackServer, monkeypatch: pytest.MonkeyPatch, *, timeout: float = 2.0
) -> None:
    def build(**_: object) -> httpx.AsyncClient:
        return loopback_client(server, timeout=timeout)

    monkeypatch.setattr("agent_runtime.harness.media_check.public_client", build)


__all__ = ["LoopbackServer", "Route", "checks_reach", "loopback_client", "loopback_server"]
