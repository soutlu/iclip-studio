from __future__ import annotations

import asyncio
import time
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal, Self

from fastmcp.client.transports import SSETransport, StreamableHttpTransport
from pydantic_ai.capabilities import MCP, AbstractCapability
from pydantic_ai.mcp import MCPToolset
from pydantic_ai.tools import RunContext
from pydantic_ai.toolsets import WrapperToolset
from pydantic_ai.toolsets.abstract import ToolsetTool

from cue.secrets import MASK

McpTransportKind = Literal["streamable_http", "sse"]


@dataclass(frozen=True, slots=True)
class McpConnection:
    url: str
    transport: McpTransportKind
    timeout_seconds: int
    headers: Mapping[str, str]


@dataclass(frozen=True, slots=True)
class McpToolInfo:
    name: str
    title: str | None
    description: str | None


@dataclass(frozen=True, slots=True)
class McpProbeOutcome:
    ok: bool
    elapsed_ms: int
    reason: str | None
    tools: tuple[McpToolInfo, ...] | None


class McpServerUnreachable(RuntimeError):
    pass


def _toolset(connection: McpConnection) -> MCPToolset[Any]:
    headers = dict(connection.headers)
    transport = (
        StreamableHttpTransport(connection.url, headers=headers)
        if connection.transport == "streamable_http"
        else SSETransport(connection.url, headers=headers)
    )
    return MCPToolset(
        transport,
        init_timeout=connection.timeout_seconds,
        read_timeout=connection.timeout_seconds,
    )


async def probe_mcp(connection: McpConnection) -> McpProbeOutcome:
    started = time.monotonic()
    toolset = _toolset(connection)
    try:
        async with asyncio.timeout(connection.timeout_seconds), toolset:
            listed = await toolset.client.list_tools()
    except Exception as exc:
        return McpProbeOutcome(
            ok=False,
            elapsed_ms=_elapsed_ms(started),
            reason=failure_reason(exc, connection),
            tools=None,
        )
    return McpProbeOutcome(
        ok=True,
        elapsed_ms=_elapsed_ms(started),
        reason=None,
        tools=tuple(
            McpToolInfo(
                name=one.name,
                title=one.title or (one.annotations and one.annotations.title) or None,
                description=one.description,
            )
            for one in listed
        ),
    )


def mcp_capability(
    *,
    server_id: str,
    server_name: str,
    connection: McpConnection,
    tools: Sequence[str] | None,
    tool_prefix: str,
) -> AbstractCapability[Any]:
    return MCP(
        local=_NamedServer(
            _toolset(connection),
            server_id=server_id,
            server_name=server_name,
            connection=connection,
        ),
        id=server_id,
        allowed_tools=None if tools is None else list(tools),
        tool_prefix=tool_prefix,
    )


@dataclass
class _NamedServer(WrapperToolset[Any]):
    server_id: str = field(kw_only=True)
    server_name: str = field(kw_only=True)
    connection: McpConnection = field(kw_only=True, repr=False)

    async def __aenter__(self) -> Self:
        try:
            await self.wrapped.__aenter__()
        except Exception as exc:
            raise self._unreachable(exc) from exc
        return self

    async def get_tools(self, ctx: RunContext[Any]) -> dict[str, ToolsetTool[Any]]:
        try:
            return await self.wrapped.get_tools(ctx)
        except Exception as exc:
            raise self._unreachable(exc) from exc

    def _unreachable(self, exc: Exception) -> McpServerUnreachable:
        reason = failure_reason(exc, self.connection)
        return McpServerUnreachable(
            f"MCP 服务 {self.server_name}（{self.server_id}）连不上：{reason}"
        )


def failure_reason(exc: BaseException, connection: McpConnection) -> str:
    if any(isinstance(one, TimeoutError) for one in _chain(exc)):
        return f"{connection.timeout_seconds} 秒内没有答复"
    lines = str(exc).strip().splitlines()
    reason = lines[0] if lines else type(exc).__name__
    for value in (connection.url, *connection.headers.values()):
        reason = reason.replace(value, MASK)
    return reason


def _chain(exc: BaseException) -> Iterator[BaseException]:
    seen: set[int] = set()
    queue: list[BaseException] = [exc]
    while queue:
        one = queue.pop(0)
        if id(one) in seen:
            continue
        seen.add(id(one))
        yield one
        if isinstance(one, BaseExceptionGroup):
            queue.extend(one.exceptions)
        queue.extend(cause for cause in (one.__cause__, one.__context__) if cause is not None)


def _elapsed_ms(started: float) -> int:
    return round((time.monotonic() - started) * 1000)


__all__ = [
    "McpConnection",
    "McpProbeOutcome",
    "McpServerUnreachable",
    "McpToolInfo",
    "failure_reason",
    "mcp_capability",
    "probe_mcp",
]
