"""MCP 服务的端口：自有一张表的仓储，以及由组合根接上的试连与「谁在用」。"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Mapping, Sequence
from contextlib import AbstractAsyncContextManager
from typing import Protocol

from agent_runtime.agent_usage import AgentUsage
from agent_runtime.config.mcp_servers.models import (
    McpEndpoint,
    McpHeader,
    McpProbeResult,
    McpServerRecord,
    McpTool,
    McpTransport,
)


class McpServerEditor(Protocol):
    """一次改一个服务：开始时锁住它那一行，块正常结束提交、出错回滚。「在用时不能停用、不能删」在锁里判。"""

    @property
    def record(self) -> McpServerRecord:
        """拿到锁之后读到的这一行。"""
        ...

    async def update(
        self,
        *,
        name: str,
        description: str,
        url: str,
        url_hash: str,
        transport: McpTransport,
        timeout_seconds: int,
        headers: Sequence[McpHeader],
        enabled: bool,
        clear_check: bool,
        by: uuid.UUID,
    ) -> None:
        """各项按给的写（``url`` 与 ``headers`` 是存储形态），更新 ``updated_by`` 与 ``updated_at``；
        ``clear_check`` 为真时把上一次试连与发现的工具一起清掉。地址或名称与别的服务重复是 ``Conflict``
        （在 ``edit`` 块结束、事务回滚之后抛）。"""
        ...

    async def delete(self) -> None: ...


class McpServerStore(Protocol):
    """``mcp_servers`` 的数据访问。"""

    async def list(self) -> tuple[McpServerRecord, ...]:
        """全部服务，按建立时刻从新到旧、同一时刻按标识倒序。"""
        ...

    async def get(self, server_id: str) -> McpServerRecord | None: ...

    async def insert(
        self,
        server_id: str,
        *,
        name: str,
        description: str,
        url: str,
        url_hash: str,
        transport: McpTransport,
        timeout_seconds: int,
        headers: Sequence[McpHeader],
        enabled: bool,
        by: uuid.UUID,
    ) -> None:
        """建一行，``url`` 与 ``headers`` 是存储形态；标识已被占用，或地址、名称与已有的服务重复是
        ``Conflict``。"""
        ...

    def edit(self, server_id: str) -> AbstractAsyncContextManager[McpServerEditor]:
        """开一次修改，见 ``McpServerEditor``；没有这个服务是 ``NotFound``。"""
        ...

    async def record_check(
        self,
        server_id: str,
        *,
        ok: bool,
        elapsed_ms: int,
        reason: str | None,
        tools: Sequence[McpTool] | None,
    ) -> bool:
        """记下一次试连，时刻取数据库时钟；``tools`` 不为 ``None`` 时同时换掉发现的工具，为 ``None`` 时
        发现的工具不动。这一行已不在交回 ``False``。不改 ``updated_at``。"""
        ...

    async def rewrite_secrets(self, rewrite: Callable[[McpServerRecord], McpServerRecord]) -> int:
        """在一个事务里锁住全部服务，逐个用 ``rewrite`` 算出新的存储形态，只写回其中的 ``url`` 与
        ``headers``；交回改了几个。"""
        ...


class McpProbe(Protocol):
    """连一次 MCP 服务并列出它的工具。每次都是一次真实的连接。"""

    async def probe(self, endpoint: McpEndpoint) -> McpProbeResult:
        """连不上、被拒、超时都放进结果，不抛；结果里不带地址与请求头的值。"""
        ...


class McpUsages(Protocol):
    """哪些 agent 挂着哪个 MCP 服务，由组合根接到 agent 配置域：草稿或当前版本里写的才算。"""

    async def mcp_server_users(self) -> Mapping[str, tuple[AgentUsage, ...]]:
        """服务标识到挂着它的 agent（同一 agent 合成一条，按标识排）；没人挂的服务不在里面。"""
        ...


__all__ = ["McpProbe", "McpServerEditor", "McpServerStore", "McpUsages"]
