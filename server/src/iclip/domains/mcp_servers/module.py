from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Final
from urllib.parse import urlsplit

from iclip.domains.mcp_servers.api import (
    Conversations,
    create_mcp_connections_router,
    create_mcp_servers_router,
)
from iclip.platform.runtime_api.client import RuntimeClient

MCP_CALLBACK_PATH: Final = "/mcp/callback"


@dataclass(frozen=True)
class McpServersModule:
    routers: tuple[Any, ...]


def mcp_callback_url(sso_redirect_url: str) -> str:
    """授权服务器回调的前端地址：SSO 回跳地址的源加上固定的前端路径。"""

    parts = urlsplit(sso_redirect_url)
    return f"{parts.scheme}://{parts.netloc}{MCP_CALLBACK_PATH}"


def build_mcp_servers_module(
    runtime: RuntimeClient, conversations: Conversations, *, sso_redirect_url: str | None
) -> McpServersModule:
    callback_url = None if sso_redirect_url is None else mcp_callback_url(sso_redirect_url)
    return McpServersModule(
        routers=(
            create_mcp_servers_router(runtime, callback_url=callback_url),
            create_mcp_connections_router(runtime, conversations, callback_url=callback_url),
        )
    )


__all__ = ["MCP_CALLBACK_PATH", "McpServersModule", "build_mcp_servers_module", "mcp_callback_url"]
