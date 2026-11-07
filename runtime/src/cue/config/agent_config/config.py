from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence
from typing import Annotated, Any, Final, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    ValidationError,
    field_validator,
)
from pydantic_core import ErrorDetails

from cue.config.agent_config.models import AgentRefs, AgentState, ConfigRefs, Problem
from cue.model_vocab import ThinkingEffort

SCHEMA_VERSION: Final = 1

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


def empty_config() -> AgentConfig:
    return AgentConfig(schema_version=SCHEMA_VERSION)


def dump_config(config: AgentConfig) -> dict[str, Any]:
    return config.model_dump(mode="json")


def load_config(stored: Mapping[str, Any]) -> AgentConfig:
    return AgentConfig.model_validate(stored)


def parse_config(raw: object, *, prefix: str = "") -> AgentConfig | tuple[Problem, ...]:
    try:
        return AgentConfig.model_validate(raw)
    except ValidationError as exc:
        return problems_from_errors(exc.errors(), prefix=prefix)


_TOOLS_FIELD: Final = "tools"

_MESSAGES: Final[Mapping[str, str]] = {
    "missing": "必填",
    "extra_forbidden": "不认识这个字段",
    "union_tag_not_found": "缺少 type",
    "string_type": "应是文字",
    "string_too_short": "不能为空",
    "string_too_long": "太长了",
    "bool_type": "应是 true 或 false",
    "bool_parsing": "应是 true 或 false",
    "int_type": "应是整数",
    "int_parsing": "应是整数",
    "int_from_float": "应是整数",
    "float_type": "应是数字",
    "float_parsing": "应是数字",
    "greater_than": "必须大于 0",
    "greater_than_equal": "必须不小于 1",
    "uuid_type": "应是 UUID",
    "uuid_parsing": "应是 UUID",
    "dict_type": "应是键值对",
    "model_type": "应是键值对",
    "model_attributes_type": "应是键值对",
    "list_type": "应是列表",
    "tuple_type": "应是列表",
}


def problems_from_errors(
    errors: Sequence[ErrorDetails], *, prefix: str = ""
) -> tuple[Problem, ...]:
    return tuple(
        Problem(path=_join(prefix, _path(error["loc"])), message=_message(error))
        for error in errors
    )


def _message(error: ErrorDetails) -> str:
    kind = error["type"]
    if kind == "value_error":
        return str(error["msg"]).removeprefix("Value error, ")
    if kind == "union_tag_invalid":
        tag = (error.get("ctx") or {}).get("tag")
        return f"不认识的 type：{tag}" if tag else "不认识的 type"
    if kind == "literal_error":
        expected = (error.get("ctx") or {}).get("expected")
        return f"只能是 {expected}" if expected else "取值不对"
    return _MESSAGES.get(kind, str(error["msg"]))


def _path(loc: Sequence[int | str]) -> str:
    parts = list(loc)
    if len(parts) >= 3 and parts[0] == _TOOLS_FIELD and isinstance(parts[1], int):
        del parts[2]
    rendered = ""
    for part in parts:
        if isinstance(part, int):
            rendered += f"[{part}]"
        else:
            rendered += f".{part}" if rendered else str(part)
    return rendered


def _join(prefix: str, path: str) -> str:
    if not prefix:
        return path
    if not path:
        return prefix
    return f"{prefix}{path}" if path.startswith("[") else f"{prefix}.{path}"


def config_refs(stored: Mapping[str, Any], skill_ids: Sequence[uuid.UUID]) -> ConfigRefs:
    config = load_config(stored)
    return ConfigRefs(
        provider=config.model.provider if config.model is not None else None,
        model=config.model.name if config.model is not None else None,
        credential_id=config.model.credential_id if config.model is not None else None,
        skill_ids=tuple(skill_ids),
        subagents=tuple(sub.agent for sub in config.subagents),
        mcp_servers=tuple(tool.server for tool in config.tools if isinstance(tool, McpToolConfig)),
    )


def agent_refs(state: AgentState) -> AgentRefs:
    agent = state.agent
    return AgentRefs(
        agent_id=agent.id,
        name=agent.name,
        description=agent.description,
        status=agent.status,
        active_version_id=agent.active_version_id,
        draft=config_refs(state.draft.config, state.draft.skill_ids),
        active=config_refs(state.active.config, state.active.skill_ids)
        if state.active is not None
        else None,
    )


__all__ = [
    "SCHEMA_VERSION",
    "AgentConfig",
    "AgentModelRef",
    "AgentModelSettings",
    "CapToolConfig",
    "McpToolConfig",
    "SubagentConfig",
    "ToolConfig",
    "agent_refs",
    "config_refs",
    "dump_config",
    "empty_config",
    "load_config",
    "parse_config",
    "problems_from_errors",
]
