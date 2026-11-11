from __future__ import annotations

import uuid
from typing import Annotated, Final, Protocol

from fastapi import APIRouter, Depends, Query, Response

from iclip.common.errors import Conflict, PermissionDenied, ValidationFailed
from iclip.domains.identity.public import Principal, require_authenticated, require_permission
from iclip.domains.mcp_servers.schemas import (
    McpAuthorizeOut,
    McpCallbackUrlOut,
    McpCompleteIn,
    McpCompleteOut,
    McpConnectionOut,
    McpConnectionsOut,
)
from iclip.platform.runtime_admin import admin_path, relay
from iclip.platform.runtime_api.app_wire import (
    MAX_AGENT_ID_CHARS,
    McpAuthorizeIn,
)
from iclip.platform.runtime_api.app_wire import McpCompleteIn as RuntimeCompleteIn
from iclip.platform.runtime_api.client import RuntimeClient
from iclip.platform.runtime_api.config.mcp_servers.schemas import (
    McpCheckIn,
    McpCheckOut,
    McpConnectionsAffectedOut,
    McpServerCreateIn,
    McpServerOut,
    McpServersOut,
    McpServerUpdateIn,
)

_MANAGE: Final = "agent:manage"

SignedIn = Annotated[Principal, Depends(require_authenticated)]


class McpCallbackUnconfigured(Conflict):
    code = "mcp_callback_unconfigured"


class Conversations(Protocol):
    async def agent_of(
        self, principal: Principal, conversation_id: str, *, writing: bool
    ) -> str: ...


def create_mcp_servers_router(runtime: RuntimeClient, *, callback_url: str | None) -> APIRouter:
    router = APIRouter(prefix="/mcp-servers", tags=["mcp-servers"])

    @router.get(":callback-url", response_model=McpCallbackUrlOut)
    async def mcp_callback_url(
        _principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> McpCallbackUrlOut:
        """连接时发给授权服务器的回调地址，管理员在服务那边手工登记客户端时填它；没配 SSO 时为 ``null``。"""

        return McpCallbackUrlOut(callback_url=callback_url)

    @router.get("", response_model=McpServersOut)
    async def mcp_servers(
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """全部 MCP 服务，带打码的请求头、上一次试连、发现的工具、挂着它的 agent 与按用户登录的现状。"""

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

    @router.patch(
        "/{server_id}",
        response_model=McpServerOut,
        responses={
            409: {
                "model": McpConnectionsAffectedOut,
                "description": "会断开或作废已连接用户的连接，要带 confirmReconnect 再发",
            }
        },
    )
    async def update_mcp_server(
        server_id: str,
        body: McpServerUpdateIn,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """改给了的项，不连它；有 agent 挂着时不能停用。会影响已连接用户而没带 ``confirmReconnect`` 是
        409 ``mcp_connections_affected``，``affectedUsers`` 是受影响的人数，什么都不改。"""

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
        """删一个 MCP 服务，连同用户在它上面的连接；有 agent 挂着时不能删。"""

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


def create_mcp_connections_router(
    runtime: RuntimeClient, conversations: Conversations, *, callback_url: str | None
) -> APIRouter:
    """当前登录用户在按用户登录的 MCP 服务上的连接，代的总是登录的这个人。

    ``callback_url`` 是授权服务器回调的前端地址，由服务端配置定下、不取自请求；没有时不能发起登录。运行时
    拒绝的都是 409，``code`` 原样带回。
    """

    router = APIRouter(prefix="/mcp-connections", tags=["mcp-connections"])

    @router.get("", response_model=McpConnectionsOut)
    async def mcp_connections(
        principal: SignedIn,
        conversation_id: Annotated[uuid.UUID | None, Query(alias="conversationId")] = None,
        agent_id: Annotated[
            str | None, Query(alias="agentId", min_length=1, max_length=MAX_AGENT_ID_CHARS)
        ] = None,
        draft: bool = False,
    ) -> McpConnectionsOut:
        """启用的、按用户登录的 MCP 服务与我在各服务上的连接。不给参数列全部；给了只列运行会连的：这份配置与
        它的子 agent 的当前版本挂着、且有工具放给模型的。

        已有的对话给 ``conversationId``：按这段对话锁定的版本（测试预览按它跑的那份）算；要是我能发消息的
        对话或我的测试预览，否则 404；对话没有能跑的版本是 409 ``agent_unavailable``。还没建的对话给
        ``agentId``：按这个 agent 的当前版本（``draft=true`` 时是草稿，要 ``agent:manage``）算；没有这个
        agent 是 404。``conversationId`` 与 ``agentId`` 或 ``draft=true`` 一起给是 422。"""

        if conversation_id is not None:
            if agent_id is not None or draft:
                raise ValidationFailed("conversationId 不能与 agentId 或 draft 一起给")
            await conversations.agent_of(principal, str(conversation_id), writing=True)
        elif draft and not principal.has(_MANAGE):
            raise PermissionDenied(f"需要 {_MANAGE} 权限")
        found = await runtime.mcp_connections(
            user=principal.user_id, agent_id=agent_id, draft=draft, session_id=conversation_id
        )
        return McpConnectionsOut(
            items=[
                McpConnectionOut(
                    server_id=one.server_id,
                    name=one.name,
                    description=one.description,
                    state=one.state,
                    account=one.account,
                    scopes=None if one.scopes is None else list(one.scopes),
                    connected_at=one.connected_at,
                )
                for one in found.items
            ]
        )

    @router.post("/{server_id}/authorize", response_model=McpAuthorizeOut)
    async def authorize_mcp(server_id: str, principal: SignedIn) -> McpAuthorizeOut:
        """发起连接，返回让浏览器去的授权地址（5 分钟内有效）；授权服务器回调到前端的 ``/mcp/callback``。"""

        if callback_url is None:
            raise McpCallbackUnconfigured(
                "没有配置 SSO_REDIRECT_URL，不能连接按用户登录的 MCP 服务"
            )
        started = await runtime.authorize_mcp(
            server_id, McpAuthorizeIn(redirect_uri=callback_url), user=principal.user_id
        )
        return McpAuthorizeOut(authorization_url=started.authorization_url)

    @router.post("/complete", response_model=McpCompleteOut)
    async def complete_mcp(body: McpCompleteIn, principal: SignedIn) -> McpCompleteOut:
        """用回调带回的 ``state`` 与 ``code`` 完成连接，答连上的是哪个服务；替换我原有的连接。要由发起的
        那个人来完成。"""

        done = await runtime.complete_mcp(
            RuntimeCompleteIn(state=body.state, code=body.code, iss=body.iss),
            user=principal.user_id,
        )
        return McpCompleteOut(server_id=done.server_id, name=done.name, account=done.account)

    @router.delete("/{server_id}", status_code=204)
    async def disconnect_mcp(server_id: str, principal: SignedIn) -> Response:
        """断开我在这个服务上的连接；本来没连也是 204。"""

        await runtime.disconnect_mcp(server_id, user=principal.user_id)
        return Response(status_code=204)

    return router


__all__ = [
    "Conversations",
    "McpCallbackUnconfigured",
    "create_mcp_connections_router",
    "create_mcp_servers_router",
]
