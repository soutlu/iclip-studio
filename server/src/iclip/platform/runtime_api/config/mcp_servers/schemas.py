from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from iclip.platform.runtime_api.agent_usage import AgentUsageOut
from iclip.platform.runtime_api.config.mcp_servers.models import (
    DEFAULT_TIMEOUT_SECONDS,
    McpTransport,
)


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
    name: str
    description: str = ""
    url: str
    transport: McpTransport
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS
    headers: list[McpHeaderIn] = []
    enabled: bool = True


class McpServerUpdateIn(CamelModel):
    """不给或给 ``null`` 的项不动，``url`` 不给就沿用原来的地址。给了 ``headers`` 就整份替换请求头，其中
    没给 ``value`` 的沿用同名请求头原来的值。"""

    name: str | None = None
    description: str | None = None
    url: str | None = None
    transport: McpTransport | None = None
    timeout_seconds: int | None = None
    headers: list[McpHeaderIn] | None = None
    enabled: bool | None = None


class McpCheckIn(CamelModel):
    """试连一份还没保存的配置，什么都不存。给了 ``serverId`` 时，没给 ``url`` 就用那个已保存的服务的地址，
    没给 ``value`` 的请求头取它里面同名请求头的值；没给 ``serverId`` 时 ``url`` 与每个请求头的 ``value``
    都要给。"""

    server_id: str | None = None
    url: str | None = None
    transport: McpTransport
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS
    headers: list[McpHeaderIn] = []


class McpHeaderOut(CamelModel):
    name: str
    value: str


class McpToolOut(CamelModel):
    name: str
    title: str | None
    description: str | None


class McpLastCheckOut(CamelModel):
    ok: bool
    elapsed_ms: int
    reason: str | None
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
    tools: list[McpToolOut] | None
    used_by: list[AgentUsageOut]
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
    tools: list[McpToolOut] | None


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
