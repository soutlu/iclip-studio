"""工具卡显示表的合并：插件登记表里各插件的表，加上技能与委派两件引擎自带的工具，以及 MCP 服务的工具。"""

from __future__ import annotations

from typing import Any, Final

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
"""名册里没有这个服务（已删掉）时卡头的标题。"""


def build_display_registry(registry: PluginRegistry, mcp: McpServerIndex) -> ToolDisplayRegistry:
    """合并插件、技能与委派工具的显示表，重复工具名在装配期报错。实时与历史共用结果实例。

    ``mcp`` 是 MCP 服务的名册，MCP 工具的卡头每次投影时按它当下的内容画。"""

    return ToolDisplayRegistry.merged(
        *(plugin.display_table() for plugin in registry.values()),
        skill_display_table(),
        delegate_display_table(),
        unlisted=mcp_tool_display(mcp),
    )


def mcp_tool_display(servers: McpServerIndex) -> NamedDisplayFn:
    """MCP 服务的工具（``mcp_<服务标识>_<工具名>``）的画法，按名册查服务。

    卡头标题是服务的名称，主语是服务给这件工具的显示名；没给显示名、或名册里这个服务没记着这件工具（还没试连过、
    或试连之后服务多了工具）时没有主语。名册里没有这个服务（已删掉）时标题是「MCP 服务」、没有主语。工具说明是
    写给模型的，服务自己给的工具名是内部标识，都不上卡头。不是 ``mcp_`` 写法的名字交回 ``None``。"""

    def draw(name: str, _args: Any) -> ToolDisplay | None:
        found = split_mcp_tool_name(name)
        if found is None:
            return None
        server_id, tool = found
        server = servers.get(server_id)
        if server is None:
            return GenericDisplay(summary=UNKNOWN_MCP_SERVER)
        return GenericDisplay(summary=server.name, detail=server.tools.get(tool))

    return draw


__all__ = [
    "UNKNOWN_MCP_SERVER",
    "build_display_registry",
    "mcp_tool_display",
]
