"""工具卡显示表的合并：插件登记表里各插件的表，加上技能与委派两件引擎自带的工具。"""

from __future__ import annotations

from agent_runtime.harness.agents import delegate_display_table
from agent_runtime.harness.skills import skill_display_table
from agent_runtime.plugins.base import PluginRegistry
from agent_runtime.transcript.display import ToolDisplayRegistry


def build_display_registry(registry: PluginRegistry) -> ToolDisplayRegistry:
    """合并插件、技能与委派工具的显示表，重复工具名在装配期报错。实时与历史共用结果实例。"""

    return ToolDisplayRegistry.merged(
        *(plugin.display_table() for plugin in registry.values()),
        skill_display_table(),
        delegate_display_table(),
    )


__all__ = ["build_display_registry"]
