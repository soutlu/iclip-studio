from __future__ import annotations

from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from iclip.platform.runtime_api.app_wire import McpConnectionStateWire


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True
    )


class McpConnectionOut(CamelModel):
    """一个按用户登录的 MCP 服务与当前用户在它上面的连接：``connected`` 已连接，``invalid`` 连接已失效、要
    重新连接，``none`` 未连接。``scopes`` 是授权服务器给的权限范围，``connectedAt`` 是这次连接建立的时间。"""

    server_id: str
    name: str
    description: str
    state: McpConnectionStateWire
    account: str | None
    scopes: list[str] | None
    connected_at: datetime | None


class McpConnectionsOut(CamelModel):
    items: list[McpConnectionOut]


class McpAuthorizeOut(CamelModel):
    """让浏览器去的授权地址，5 分钟内回到前端的 ``/mcp/callback`` 完成。"""

    authorization_url: str


class McpCallbackUrlOut(CamelModel):
    callback_url: str | None


class McpCompleteIn(CamelModel):
    """授权服务器回调到 ``/mcp/callback`` 时带的参数，原样交回；``iss`` 有就给。"""

    state: Annotated[str, Field(min_length=1, max_length=512)]
    code: Annotated[str, Field(min_length=1, max_length=4096)]
    iss: str | None = None


class McpCompleteOut(CamelModel):
    server_id: str
    name: str
    account: str | None


__all__ = [
    "McpAuthorizeOut",
    "McpCallbackUrlOut",
    "McpCompleteIn",
    "McpCompleteOut",
    "McpConnectionOut",
    "McpConnectionsOut",
]
