"""mcp_servers 装配单元：组合根只调用 ``build_mcp_servers_module``。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from agent_runtime.client import RuntimeClient

from iclip.domains.mcp_servers.api import create_mcp_servers_router


@dataclass(frozen=True)
class McpServersModule:
    routers: tuple[Any, ...]
    """使用 Any 隔离 Web 框架类型。"""


def build_mcp_servers_module(runtime: RuntimeClient) -> McpServersModule:
    """端点都转给运行时服务，``runtime`` 是组合根建的那一个客户端。"""

    return McpServersModule(routers=(create_mcp_servers_router(runtime),))


__all__ = ["McpServersModule", "build_mcp_servers_module"]
