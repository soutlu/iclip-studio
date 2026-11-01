"""MCP 服务端点的请求与响应形状，camelCase 别名。术语见 docs/CONTEXT.md「MCP 服务」。"""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from agent_runtime.agent_usage import AgentUsageOut
from agent_runtime.config.mcp_servers.models import DEFAULT_TIMEOUT_SECONDS, McpTransport


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True
    )


class McpHeaderIn(CamelModel):
    """一个请求头。改已保存的服务时 ``value`` 可以不给，就是沿用同名请求头原来的值；新建时必须给。"""

    name: str
    value: str | None = None


class McpServerCreateIn(CamelModel):
    id: str
    """标识，创建后不能改。"""
    name: str
    description: str = ""
    url: str
    transport: McpTransport
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS
    headers: list[McpHeaderIn] = []
    enabled: bool = True


class McpServerUpdateIn(CamelModel):
    """不给或给 ``null`` 的项不动。给了 ``headers`` 就整份替换请求头，其中没给 ``value`` 的沿用同名请求头
    原来的值。"""

    name: str | None = None
    description: str | None = None
    url: str | None = None
    transport: McpTransport | None = None
    timeout_seconds: int | None = None
    headers: list[McpHeaderIn] | None = None
    enabled: bool | None = None


class McpCheckIn(CamelModel):
    """试连一份还没保存的配置，什么都不存。给了 ``serverId`` 时，没给 ``value`` 的请求头取那个已保存的服务
    里同名请求头的值；没给 ``serverId`` 时每个请求头都要给 ``value``。"""

    server_id: str | None = None
    url: str
    transport: McpTransport
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS
    headers: list[McpHeaderIn] = []


class McpHeaderOut(CamelModel):
    name: str
    value: str
    """打码后的样子：``••••`` 加末 4 位，原值不足 8 位只有 ``••••``。"""


class McpToolOut(CamelModel):
    name: str
    """服务自己给的工具名；agent 里看到的名字前面另加 ``mcp_<服务标识>_``。"""
    description: str | None


class McpLastCheckOut(CamelModel):
    ok: bool
    elapsed_ms: int
    reason: str | None
    """没通的原因，给人看的一句话；通了为 ``null``。"""
    checked_at: datetime


class McpServerOut(CamelModel):
    id: str
    name: str
    description: str
    url: str
    transport: McpTransport
    timeout_seconds: int
    headers: list[McpHeaderOut]
    enabled: bool
    last_check: McpLastCheckOut | None
    """最后一次试连；从没试过为 ``null``。"""
    tools: list[McpToolOut] | None
    """最后一次试连成功时发现的工具，按服务给的先后；从没成功过为 ``null``。"""
    used_by: list[AgentUsageOut]
    """草稿或当前版本挂着这个服务的 agent，按 agent 标识排；它们还在用时不能停用或删除。"""
    created_by: uuid.UUID
    updated_by: uuid.UUID
    created_at: datetime
    updated_at: datetime


class McpServersOut(CamelModel):
    items: list[McpServerOut]


class McpCheckOut(CamelModel):
    """一次试连。没通也是 ``200``，看 ``ok``。"""

    ok: bool
    elapsed_ms: int
    reason: str | None
    """没通的原因，给人看的一句话；通了为 ``null``。"""
    tools: list[McpToolOut] | None
    """发现的工具，按服务给的先后；没通为 ``null``。"""


__all__ = [
    "McpCheckIn",
    "McpCheckOut",
    "McpHeaderIn",
    "McpHeaderOut",
    "McpLastCheckOut",
    "McpServerCreateIn",
    "McpServerOut",
    "McpServerUpdateIn",
    "McpServersOut",
    "McpToolOut",
]
