"""工具卡显示表的合并：插件登记表里各插件的表，加上技能与委派两件引擎自带的工具，以及 MCP 服务的工具。"""

from __future__ import annotations

import re
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

MAX_TOOL_BRIEF_CHARS: Final = 40
"""卡头主语里工具说明的上限（字符）。"""

# 句末：中文句号、问叹号，或后面是空白、结尾的英文句点（``v1.2`` 里的点不算），以及换行。
_SENTENCE_END: Final = re.compile(r"[。！？!?\n]|\.(?=\s|$)")
_CLAUSE_END: Final = re.compile(r"[，,；;：:]")


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

    卡头标题是服务的名称，主语是这件工具的说明：取第一句（不带句末标点），超过
    ``MAX_TOOL_BRIEF_CHARS`` 取第一个分句，还超就截断加「…」。工具没有说明、或名册里这个服务没记着这件
    工具（还没试连过、或试连之后服务多了工具）时主语是服务自己给的工具名。名册里没有这个服务（已删掉）时
    标题是「MCP 服务」、主语是工具名。不是 ``mcp_`` 写法的名字交回 ``None``。"""

    def draw(name: str, _args: Any) -> ToolDisplay | None:
        found = split_mcp_tool_name(name)
        if found is None:
            return None
        server_id, tool = found
        server = servers.get(server_id)
        if server is None:
            return GenericDisplay(summary=UNKNOWN_MCP_SERVER, detail=tool)
        brief = _brief(server.tools.get(tool))
        return GenericDisplay(summary=server.name, detail=tool if brief is None else brief)

    return draw


def _brief(description: str | None) -> str | None:
    if description is None:
        return None
    text = _SENTENCE_END.split(description.strip(), maxsplit=1)[0].strip()
    if len(text) > MAX_TOOL_BRIEF_CHARS:
        clause = _CLAUSE_END.split(text, maxsplit=1)[0].strip()
        if clause:
            text = clause
    if len(text) > MAX_TOOL_BRIEF_CHARS:
        text = text[: MAX_TOOL_BRIEF_CHARS - 1].rstrip() + "…"
    return text or None


__all__ = [
    "MAX_TOOL_BRIEF_CHARS",
    "UNKNOWN_MCP_SERVER",
    "build_display_registry",
    "mcp_tool_display",
]
