from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Final, cast

from agent_runtime.config.agent_config.public import split_mcp_tool_name
from agent_runtime.config.mcp_servers.public import McpServerIndex
from agent_runtime.harness.agents import delegate_display_table
from agent_runtime.harness.skills import skill_display_table
from agent_runtime.plugins.base import PluginRegistry
from agent_runtime.transcript.display import (
    GenericDisplay,
    NamedDisplayFn,
    ToolDisplay,
    ToolDisplayRegistry,
)

UNKNOWN_MCP_SERVER: Final = "MCP 服务"


def build_display_registry(registry: PluginRegistry, mcp: McpServerIndex) -> ToolDisplayRegistry:
    return ToolDisplayRegistry.merged(
        *(plugin.display_table() for plugin in registry.values()),
        skill_display_table(),
        delegate_display_table(),
        unlisted=mcp_tool_display(mcp),
    )


def mcp_tool_display(servers: McpServerIndex) -> NamedDisplayFn:
    def draw(name: str, args: Any) -> ToolDisplay | None:
        found = split_mcp_tool_name(name)
        if found is None:
            return None
        server_id, tool = found
        server = servers.get(server_id)
        if server is None:
            summary = UNKNOWN_MCP_SERVER
        else:
            title = server.tools.get(tool)
            summary = server.name if title is None else f"{server.name} · {title}"
        return GenericDisplay(summary=summary, detail=_key_argument(args))

    return draw


def _key_argument(args: Any) -> str | None:
    if not isinstance(args, Mapping):
        return None
    for value in cast(Mapping[str, Any], args).values():
        if isinstance(value, str) and (line := value.strip().split("\n")[0].strip()):
            return line
    return None


__all__ = [
    "UNKNOWN_MCP_SERVER",
    "build_display_registry",
    "mcp_tool_display",
]
