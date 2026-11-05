from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from agent_runtime.client import RuntimeClient

from iclip.domains.mcp_servers.api import create_mcp_servers_router


@dataclass(frozen=True)
class McpServersModule:
    routers: tuple[Any, ...]


def build_mcp_servers_module(runtime: RuntimeClient) -> McpServersModule:
    return McpServersModule(routers=(create_mcp_servers_router(runtime),))


__all__ = ["McpServersModule", "build_mcp_servers_module"]
