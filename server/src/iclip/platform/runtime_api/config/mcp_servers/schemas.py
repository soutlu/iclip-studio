from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from iclip.platform.runtime_api.agent_usage import AgentUsageOut
from iclip.platform.runtime_api.config.mcp_servers.models import (
    DEFAULT_TIMEOUT_SECONDS,
    McpAuthMode,
    McpClientStatus,
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


class McpOAuthClientIn(CamelModel):
    """管理员填的客户端，给不能自动注册的服务用。改的时候 ``clientSecret`` 不给，客户端 ID 没变就沿用原来的
    密钥，变了就是没有密钥。"""

    client_id: str
    client_secret: str | None = None


class McpServerCreateIn(CamelModel):
    """``authMode`` 为 ``per_user`` 时每个用户用自己的账户登录。``oauthScopes`` 是要请求的权限范围，不给是
    服务公布的全部；登录与保持连接用的几个（``openid``、``email``、``profile``、``offline_access``）服务
    公布了就总会请求。"""

    id: str
    name: str
    description: str = ""
    url: str
    transport: McpTransport
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS
    headers: list[McpHeaderIn] = []
    enabled: bool = True
    auth_mode: McpAuthMode = "shared"
    oauth_scopes: list[str] | None = None
    oauth_client: McpOAuthClientIn | None = None


class McpServerUpdateIn(CamelModel):
    """不给或给 ``null`` 的项不动，``url`` 不给就沿用原来的地址。给了 ``headers`` 就整份替换请求头，其中
    没给 ``value`` 的沿用同名请求头原来的值。

    ``oauthScopes`` 给了就整份替换要请求的权限范围；``oauthClient`` 给了就换掉管理员填的客户端。改地址、关掉
    ``per_user`` 会断开全部连接；缩小权限范围会作废拿到了更多权限的连接；换了客户端 ID 会作废令牌发给旧客户端
    的连接（只换密钥不会）。会影响已连接的用户时不带 ``confirmReconnect: true`` 就答 409
    ``mcp_connections_affected``，带着受影响的人数。"""

    name: str | None = None
    description: str | None = None
    url: str | None = None
    transport: McpTransport | None = None
    timeout_seconds: int | None = None
    headers: list[McpHeaderIn] | None = None
    enabled: bool | None = None
    auth_mode: McpAuthMode | None = None
    oauth_scopes: list[str] | None = None
    oauth_client: McpOAuthClientIn | None = None
    confirm_reconnect: bool = False


class McpCheckIn(CamelModel):
    """试连一份还没保存的配置，什么都不存。给了 ``serverId`` 时，没给 ``url`` 就用那个已保存的服务的地址，
    没给 ``value`` 的请求头取它里面同名请求头的值，没给 ``authMode`` 就用它的；没给 ``serverId`` 时 ``url``
    与每个请求头的 ``value`` 都要给，``authMode`` 不给是 ``shared``。按用户登录（``per_user``）的配置不能这样
    试连：先保存，再用已保存的服务试连。"""

    server_id: str | None = None
    url: str | None = None
    transport: McpTransport
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS
    headers: list[McpHeaderIn] = []
    auth_mode: McpAuthMode | None = None


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


class McpOAuthClientOut(CamelModel):
    client_id: str
    client_secret: str | None


class McpOAuthOut(CamelModel):
    """按用户登录的设置与现状。

    - ``scopes``：管理员挑的权限范围，``null`` 是服务公布的全部。
    - ``publishedScopes`` / ``signInScopes`` / ``requestedScopes``：服务公布的可挑的权限范围、公布了的登录用的
      几个、登录时实际请求的；还没发现过服务（第一次有人发起登录时发现）时都是 ``null``。
    - ``client``：``unknown`` 还没发现过；``automatic`` 自动注册；``preset`` 用管理员填的；``required`` 服务
      不能自动注册，要管理员填客户端 ID。
    - ``connectedUsers``：连接有效的用户数。管理员自己的连接见 ``GET /v1/mcp-connections``。
    """

    scopes: list[str] | None
    published_scopes: list[str] | None
    sign_in_scopes: list[str] | None
    requested_scopes: list[str] | None
    client: McpClientStatus
    preset_client: McpOAuthClientOut | None
    connected_users: int


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
    auth_mode: McpAuthMode
    oauth: McpOAuthOut


class McpConnectionsAffectedOut(CamelModel):
    detail: str
    code: str
    affected_users: int


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
    "McpConnectionsAffectedOut",
    "McpHeaderIn",
    "McpHeaderOut",
    "McpLastCheckOut",
    "McpOAuthClientIn",
    "McpOAuthClientOut",
    "McpOAuthOut",
    "McpServerCreateIn",
    "McpServerOut",
    "McpServerUpdateIn",
    "McpServersOut",
    "McpToolOut",
]
