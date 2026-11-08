from __future__ import annotations

import uuid
from collections.abc import Sequence
from typing import Annotated, Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
)

from iclip.platform.runtime_api.model_vocab import ThinkingEffort

_Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class AgentModelSettings(_Strict):
    thinking: ThinkingEffort | None = None


class AgentModelRef(_Strict):
    """用哪个模型：``provider`` 是供应商的引用名，``name`` 是它的 llm 模型名。"""

    provider: _Name
    name: _Name
    credential_id: uuid.UUID | None = None
    settings: AgentModelSettings = AgentModelSettings()


class CapToolConfig(_Strict):
    """挂一个插件：``toolset`` 是插件的登记名，``parameters`` 按插件自己的参数校验。"""

    type: Literal["cap"]
    toolset: _Name
    enabled: bool = True
    parameters: dict[str, Any] = Field(default_factory=dict[str, Any])


class McpToolConfig(_Strict):
    """挂一个 MCP 服务：``server`` 是服务的标识，``tools`` 是放给模型的工具（服务自己给的名字），``null``
    是全部。"""

    type: Literal["mcp"]
    server: _Name
    tools: tuple[_Name, ...] | None = None

    @field_validator("tools")
    @classmethod
    def _some_distinct_tools(cls, tools: tuple[str, ...] | None) -> tuple[str, ...] | None:
        if tools is None:
            return None
        if not tools:
            raise ValueError("至少选一个工具；要全部工具就写 null")
        if (index := _first_repeat(tools)) is not None:
            raise ValueError(f"第 {index + 1} 项与前面的重复：工具 {tools[index]} 只能写一次")
        return tools


ToolConfig = Annotated[CapToolConfig | McpToolConfig, Field(discriminator="type")]


def _tool_key(tool: CapToolConfig | McpToolConfig) -> str:
    return f"cap:{tool.toolset}" if isinstance(tool, CapToolConfig) else f"mcp:{tool.server}"


def _tool_label(tool: CapToolConfig | McpToolConfig) -> str:
    return (
        f"同一个工具集 {tool.toolset}"
        if isinstance(tool, CapToolConfig)
        else f"同一个 MCP 服务 {tool.server}"
    )


class SubagentConfig(_Strict):
    """派活给哪个 agent。后三项与派活工具的同名控制项一致，不写就不限。"""

    agent: _Name
    timeout_seconds: float | None = Field(default=None, gt=0)
    max_calls: int | None = Field(default=None, ge=1)
    on_failure: str | None = None


class AgentConfig(_Strict):
    """一个 agent 的配置。草稿里 ``model`` 可以为空，发布时必填。技能不写在这里，存在绑定表里。"""

    schema_version: Literal[1]
    instructions: str = ""
    model: AgentModelRef | None = None
    tools: tuple[ToolConfig, ...] = ()
    subagents: tuple[SubagentConfig, ...] = ()

    @field_validator("tools")
    @classmethod
    def _distinct_sources(
        cls, tools: tuple[CapToolConfig | McpToolConfig, ...]
    ) -> tuple[CapToolConfig | McpToolConfig, ...]:
        if (index := _first_repeat([_tool_key(tool) for tool in tools])) is not None:
            raise ValueError(
                f"第 {index + 1} 项与前面的重复：{_tool_label(tools[index])} 只能挂一次"
            )
        return tools

    @field_validator("subagents")
    @classmethod
    def _distinct_subagents(
        cls, subagents: tuple[SubagentConfig, ...]
    ) -> tuple[SubagentConfig, ...]:
        if (index := _first_repeat([sub.agent for sub in subagents])) is not None:
            raise ValueError(
                f"第 {index + 1} 项与前面的重复：同一个子 agent {subagents[index].agent} 只能写一次"
            )
        return subagents


def _first_repeat(values: Sequence[str]) -> int | None:
    seen: set[str] = set()
    for index, value in enumerate(values):
        if value in seen:
            return index
        seen.add(value)
    return None


__all__ = [
    "AgentConfig",
    "AgentModelRef",
    "AgentModelSettings",
    "CapToolConfig",
    "McpToolConfig",
    "SubagentConfig",
    "ToolConfig",
]
