from __future__ import annotations

import uuid
from collections.abc import Sequence
from typing import Annotated, Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    ValidationInfo,
    field_validator,
)

from iclip.platform.runtime_api.model_vocab import ThinkingEffort

_Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class AgentModelSettings(_Strict):
    """模型运行设置：``thinking`` 为思考档位，``native_tools`` 为启用的原生工具列表。"""

    thinking: ThinkingEffort | None = None
    # 未启用原生工具时省略该字段：接入应用手工同步的配置模型拒绝未知字段，保持向后兼容。
    native_tools: tuple[_Name, ...] = Field(
        default_factory=tuple[str, ...], exclude_if=lambda names: not names
    )

    @field_validator("native_tools")
    @classmethod
    def _distinct_native_tools(cls, names: tuple[str, ...]) -> tuple[str, ...]:
        if (index := _first_repeat(names)) is not None:
            raise ValueError(f"第 {index + 1} 项与前面的重复：原生工具 {names[index]} 只能写一次")
        return names


class AgentModelRef(_Strict):
    """模型引用：``provider`` 为供应商引用名，``name`` 为其 ``llm`` 模型名。"""

    provider: _Name
    name: _Name
    credential_id: uuid.UUID | None = None
    settings: AgentModelSettings = AgentModelSettings()


class CapToolConfig(_Strict):
    """内置插件挂载项：``toolset`` 为插件注册名，``parameters`` 按对应插件规则校验。"""

    type: Literal["cap"]
    toolset: _Name
    enabled: bool = True
    parameters: dict[str, Any] = Field(default_factory=dict[str, Any])


class McpToolConfig(_Strict):
    """MCP 服务挂载项：``server`` 为服务标识，``tools`` 为暴露给模型的工具列表（服务原始名称；``null``
    表示全部工具，空列表表示不暴露任何工具）；``approval_tools`` 为其中每次调用前需用户审批的工具列表。"""

    type: Literal["mcp"]
    server: _Name
    tools: tuple[_Name, ...] | None = None
    # 无审批工具时省略该字段：接入应用手工同步的配置模型拒绝未知字段，保持向后兼容。
    approval_tools: tuple[_Name, ...] = Field(default=(), exclude_if=lambda names: not names)

    @field_validator("tools")
    @classmethod
    def _distinct_tools(cls, tools: tuple[str, ...] | None) -> tuple[str, ...] | None:
        if tools is not None and (index := _first_repeat(tools)) is not None:
            raise ValueError(f"第 {index + 1} 项与前面的重复：工具 {tools[index]} 只能写一次")
        return tools

    @field_validator("approval_tools")
    @classmethod
    def _distinct_chosen_approval_tools(
        cls, names: tuple[str, ...], info: ValidationInfo
    ) -> tuple[str, ...]:
        if (index := _first_repeat(names)) is not None:
            raise ValueError(f"第 {index + 1} 项与前面的重复：工具 {names[index]} 只能写一次")
        tools = info.data.get("tools")
        if tools is None:
            return names
        for index, name in enumerate(names):
            if name not in tools:
                raise ValueError(
                    f"第 {index + 1} 项的工具 {name} 不在 tools 里：要审批的工具先得放给模型"
                )
        return names


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
    """子 Agent 委派项。后三项对应委派工具的同名控制参数，省略表示不限制。"""

    agent: _Name
    timeout_seconds: float | None = Field(default=None, gt=0)
    max_calls: int | None = Field(default=None, ge=1)
    on_failure: str | None = None


class AgentConfig(_Strict):
    """Agent 配置文档。草稿中 ``model`` 允许为空，发布时必填；技能绑定独立存储于关联表。"""

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
