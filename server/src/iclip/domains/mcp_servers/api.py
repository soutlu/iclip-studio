"""MCP 服务 HTTP 端点，约定见合同「MCP 服务」一节。全部要求 ``agent:manage``。

业务在运行时服务：每个端点验完权限与请求体，按同一个子路径转给它的 ``/v1/admin/mcp-servers``，答复原样交回
（见 ``iclip.platform.runtime_admin``）。请求与答复的声明照旧写在这里，合同由它们导出。
"""

from __future__ import annotations

from typing import Annotated

from agent_runtime.client import RuntimeClient
from agent_runtime.config.mcp_servers.schemas import (
    McpCheckIn,
    McpCheckOut,
    McpServerCreateIn,
    McpServerOut,
    McpServersOut,
    McpServerUpdateIn,
)
from fastapi import APIRouter, Response

from iclip.domains.identity.public import Principal, require_permission
from iclip.platform.runtime_admin import admin_path, relay

_MANAGE = "agent:manage"


def create_mcp_servers_router(runtime: RuntimeClient) -> APIRouter:
    router = APIRouter(prefix="/mcp-servers", tags=["mcp-servers"])

    @router.get("", response_model=McpServersOut)
    async def mcp_servers(
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """全部 MCP 服务，带打码的请求头、上一次试连、发现的工具与挂着它的 agent。"""

        return await relay(runtime, "GET", "mcp-servers", actor=principal.user_id)

    @router.post("", response_model=McpServerOut, status_code=201)
    async def create_mcp_server(
        body: McpServerCreateIn,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """建一个 MCP 服务，不连它。"""

        return await relay(runtime, "POST", "mcp-servers", actor=principal.user_id, body=body)

    @router.post("/check", response_model=McpCheckOut)
    async def check_unsaved_mcp_server(
        body: McpCheckIn,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """按一份还没保存的配置试连，什么都不存；没通也是 200。"""

        return await relay(runtime, "POST", "mcp-servers/check", actor=principal.user_id, body=body)

    @router.get("/{server_id}", response_model=McpServerOut)
    async def mcp_server(
        server_id: str,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """一个 MCP 服务。"""

        return await relay(
            runtime, "GET", admin_path("mcp-servers", server_id), actor=principal.user_id
        )

    @router.patch("/{server_id}", response_model=McpServerOut)
    async def update_mcp_server(
        server_id: str,
        body: McpServerUpdateIn,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """改给了的项，不连它；有 agent 挂着时不能停用。"""

        return await relay(
            runtime,
            "PATCH",
            admin_path("mcp-servers", server_id),
            actor=principal.user_id,
            body=body,
        )

    @router.delete("/{server_id}", status_code=204)
    async def delete_mcp_server(
        server_id: str,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """删一个 MCP 服务；有 agent 挂着时不能删。"""

        return await relay(
            runtime, "DELETE", admin_path("mcp-servers", server_id), actor=principal.user_id
        )

    @router.post("/{server_id}/check", response_model=McpCheckOut)
    async def check_mcp_server(
        server_id: str,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """按已保存的配置试连，记下结果；通了换掉发现的工具。没通也是 200。"""

        return await relay(
            runtime,
            "POST",
            admin_path("mcp-servers", server_id, "check"),
            actor=principal.user_id,
        )

    return router


__all__ = ["create_mcp_servers_router"]
