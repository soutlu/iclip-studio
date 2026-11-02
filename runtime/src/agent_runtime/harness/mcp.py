"""MCP 服务的连接：试连并列出工具，以及把一个服务挂成 pydantic-ai 原生的 ``MCP`` capability。

客户端用官方的 ``MCPToolset``（底下是 FastMCP 的 Client），只有这里引用 ``pydantic_ai.mcp`` 与 ``fastmcp``。
连接方式按配置显式选 Streamable HTTP 或 SSE，不按地址猜；没有 stdio。服务给的 instructions 不并进提示词：
那段文字是服务写的，不该和我们自己写的提示词有同样的分量。
"""

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

from agent_runtime.secrets import MASK

McpTransportKind = Literal["streamable_http", "sse"]


@dataclass(frozen=True, slots=True)
class McpConnection:
    """连一个 MCP 服务：地址、连接方式、时限（连接与每次请求等答复的上限，秒）与明文请求头。"""

    url: str
    transport: McpTransportKind
    timeout_seconds: int
    headers: Mapping[str, str]


@dataclass(frozen=True, slots=True)
class McpToolInfo:
    """服务交出的一个工具。"""

    name: str
    description: str | None


@dataclass(frozen=True, slots=True)
class McpProbeOutcome:
    """一次试连：通了带工具，没通带原因；原因里不带地址与请求头的值。"""

    ok: bool
    elapsed_ms: int
    reason: str | None
    tools: tuple[McpToolInfo, ...] | None


class McpServerUnreachable(RuntimeError):
    """运行要用某个 MCP 服务的工具时连不上它：这次运行失败，消息写明是哪个服务、为什么。"""


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
    """连一次、列出工具再断开；整个过程不超过 ``timeout_seconds``。失败放进结果，不抛。"""

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
        tools=tuple(McpToolInfo(name=one.name, description=one.description) for one in listed),
    )


def mcp_capability(
    *,
    server_id: str,
    server_name: str,
    connection: McpConnection,
    tools: Sequence[str] | None,
    tool_prefix: str,
) -> AbstractCapability[Any]:
    """一个 MCP 服务挂成原生的 ``MCP`` capability：只在本地连（不交给模型供应商代连），``tools`` 是放给
    模型的工具（服务自己给的名字，``None`` 是全部），工具名前面加 ``tool_prefix`` 与 ``_``。连不上或列不出
    工具时抛 ``McpServerUnreachable``；单个工具调用出的错照原生的做法交给模型。"""

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
    """把连接与列工具时的失败换成写明是哪个服务的 ``McpServerUnreachable``。"""

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
    """连接失败给人看的一句话：超时换成中文，其余给 MCP 客户端报错原文的第一行；里面出现的服务地址与请求头值
    一律换成 ``MASK``（这句话会写进对话用户看得到的轮次 ``error``）。"""

    if any(isinstance(one, TimeoutError) for one in _chain(exc)):
        return f"{connection.timeout_seconds} 秒内没有答复"
    lines = str(exc).strip().splitlines()
    reason = lines[0] if lines else type(exc).__name__
    for value in (connection.url, *connection.headers.values()):
        reason = reason.replace(value, MASK)
    return reason


def _chain(exc: BaseException) -> Iterator[BaseException]:
    """这个异常与它的起因、上下文、异常组里的子异常，广度优先，各一次。"""

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
