"""工具卡显示表的合并：插件登记表里各插件的表，加上技能与委派两件引擎自带的工具，以及 MCP 服务的工具。"""

from __future__ import annotations

from typing import Any

from agent_runtime.config.agent_config.public import split_mcp_tool_name
from agent_runtime.harness.agents import delegate_display_table
from agent_runtime.harness.skills import skill_display_table
from agent_runtime.plugins.base import PluginRegistry
from agent_runtime.transcript.display import GenericDisplay, ToolDisplay, ToolDisplayRegistry


def build_display_registry(registry: PluginRegistry) -> ToolDisplayRegistry:
    """合并插件、技能与委派工具的显示表，重复工具名在装配期报错。实时与历史共用结果实例。"""

    return ToolDisplayRegistry.merged(
        *(plugin.display_table() for plugin in registry.values()),
        skill_display_table(),
        delegate_display_table(),
        unlisted=mcp_tool_display,
    )


def mcp_tool_display(name: str, _args: Any) -> ToolDisplay | None:
    """MCP 服务的工具（``mcp_<服务标识>_<工具名>``）：卡头是服务自己给的工具名，主语是服务标识。

    投影只看得到工具名与参数；服务的名称存在库里、可以改，这里不查，用不变的标识。"""

    found = split_mcp_tool_name(name)
    if found is None:
        return None
    server_id, tool = found
    return GenericDisplay(summary=tool, detail=server_id)


__all__ = ["build_display_registry", "mcp_tool_display"]
