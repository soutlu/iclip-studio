"""MCP 服务的管理接口，挂在 ``/v1/admin/mcp-servers``。约定见合同「MCP 服务」一节。"""

from __future__ import annotations

from fastapi import APIRouter, Response

from agent_runtime.config.mcp_servers.public import (
    McpCheckIn,
    McpCheckOut,
    McpServerCreateIn,
    McpServerOut,
    McpServerService,
    McpServersOut,
    McpServerUpdateIn,
)
from agent_runtime.http.auth import EndUser


def create_mcp_servers_router(service: McpServerService) -> APIRouter:
    router = APIRouter(prefix="/mcp-servers", tags=["mcp-servers"])

    @router.get("", response_model=McpServersOut)
    async def mcp_servers() -> McpServersOut:
        """全部 MCP 服务，带打码的请求头、上一次试连、发现的工具与挂着它的 agent。"""

        return await service.list()

    @router.post("", response_model=McpServerOut, status_code=201)
    async def create_mcp_server(body: McpServerCreateIn, actor: EndUser) -> McpServerOut:
        """建一个 MCP 服务，不连它。"""

        return await service.create(body, by=actor)

    @router.post("/check", response_model=McpCheckOut)
    async def check_unsaved_mcp_server(body: McpCheckIn, _actor: EndUser) -> McpCheckOut:
        """按一份还没保存的配置试连，什么都不存；没通也是 200。"""

        return await service.check_unsaved(body)

    @router.get("/{server_id}", response_model=McpServerOut)
    async def mcp_server(server_id: str) -> McpServerOut:
        """一个 MCP 服务。"""

        return await service.get(server_id)

    @router.patch("/{server_id}", response_model=McpServerOut)
    async def update_mcp_server(
        server_id: str, body: McpServerUpdateIn, actor: EndUser
    ) -> McpServerOut:
        """改给了的项，不连它；有 agent 挂着时不能停用。"""

        return await service.update(server_id, body, by=actor)

    @router.delete("/{server_id}", status_code=204)
    async def delete_mcp_server(server_id: str, _actor: EndUser) -> Response:
        """删一个 MCP 服务；有 agent 挂着时不能删。"""

        await service.delete(server_id)
        return Response(status_code=204)

    @router.post("/{server_id}/check", response_model=McpCheckOut)
    async def check_mcp_server(server_id: str, _actor: EndUser) -> McpCheckOut:
        """按已保存的配置试连，记下结果；通了换掉发现的工具。没通也是 200。"""

        return await service.check(server_id)

    return router


__all__ = ["create_mcp_servers_router"]
