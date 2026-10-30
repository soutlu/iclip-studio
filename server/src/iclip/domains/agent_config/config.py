"""Agent 配置的格式：草稿与版本存的都是这一份，导出包里也是它（去掉密钥）。

只管结构：字段、类型、同一工具集与同一子 agent 不重复。引用的供应商、模型、插件、技能与子 agent 存不存在、
能不能用，由 ``compile`` 在发布时查。"""

from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence
from typing import Annotated, Any, Final, Literal

from agent_runtime.model_vocab import ThinkingEffort
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    ValidationError,
    field_validator,
)
from pydantic_core import ErrorDetails

from iclip.domains.agent_config.models import ConfigRefs, Problem

SCHEMA_VERSION: Final = 1

_Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class AgentModelSettings(_Strict):
    thinking: ThinkingEffort | None = None
    """思考档位，必须在这个模型允许的档位里；不写就不设。"""


class AgentModelRef(_Strict):
    """用哪个模型：``provider`` 是供应商的引用名，``name`` 是它的 llm 模型名。"""

    provider: _Name
    name: _Name
    credential_id: uuid.UUID | None = None
    """用哪把密钥，必须是这个供应商的；不写就用供应商的默认密钥。导出时去掉。"""
    settings: AgentModelSettings = AgentModelSettings()


class CapToolConfig(_Strict):
    """挂一个插件：``toolset`` 是插件的登记名，``parameters`` 按插件自己的参数校验。"""

    type: Literal["cap"]
    toolset: _Name
    enabled: bool = True
    """停用的条目留在配置里，编译时去掉，也不查。"""
    parameters: dict[str, Any] = Field(default_factory=dict[str, Any])


ToolConfig = Annotated[CapToolConfig, Field(discriminator="type")]
"""按 ``type`` 区分的工具条目；以后加一种来源（如 ``mcp``）就在这里加一个分支。"""


class SubagentConfig(_Strict):
    """派活给哪个 agent。后三项与派活工具的同名控制项一致，不写就不限。"""

    agent: _Name
    timeout_seconds: float | None = Field(default=None, gt=0)
    max_calls: int | None = Field(default=None, ge=1)
    on_failure: str | None = None
    """子 agent 失败时返回给主 agent 的一段话。"""


class AgentConfig(_Strict):
    """一个 agent 的配置。草稿里 ``model`` 可以为空，发布时必填。技能不写在这里，存在绑定表里。"""

    schema_version: Literal[1]
    instructions: str = ""
    """提示词。"""
    model: AgentModelRef | None = None
    tools: tuple[ToolConfig, ...] = ()
    subagents: tuple[SubagentConfig, ...] = ()

    @field_validator("tools")
    @classmethod
    def _distinct_toolsets(cls, tools: tuple[CapToolConfig, ...]) -> tuple[CapToolConfig, ...]:
        if (index := _first_repeat([tool.toolset for tool in tools])) is not None:
            raise ValueError(
                f"第 {index + 1} 项与前面的重复：同一个工具集 {tools[index].toolset} 只能挂一次"
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
    """新建 agent 时的草稿：没有提示词、模型、工具与子 agent。"""

    return AgentConfig(schema_version=SCHEMA_VERSION)


def dump_config(config: AgentConfig) -> dict[str, Any]:
    """存库与比较用的 JSON 形态。"""

    return config.model_dump(mode="json")


def load_config(stored: Mapping[str, Any]) -> AgentConfig:
    """读回库里的配置；存进去时校验过，读不出来是持久化状态坏了，直接抛。"""

    return AgentConfig.model_validate(stored)


def parse_config(raw: object, *, prefix: str = "") -> AgentConfig | tuple[Problem, ...]:
    """校验一份外来的配置（如导入的包），不合格交回全部问题，``path`` 前面接上 ``prefix``。"""

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
    """把 pydantic 的校验错误换成问题清单：位置拼成 ``a.b[0].c``，常见的错误换成中文说明。插件参数的
    校验也用它，``prefix`` 给 ``tools[i].parameters``。"""

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
    # 区分联合类型时 pydantic 把 type 的值插在下标后面（tools[0].cap.toolset），对字段路径没有意义。
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
    """一份库里的配置连同它的技能名单引用了什么。"""

    config = load_config(stored)
    return ConfigRefs(
        provider=config.model.provider if config.model is not None else None,
        model=config.model.name if config.model is not None else None,
        credential_id=config.model.credential_id if config.model is not None else None,
        skill_ids=tuple(skill_ids),
        subagents=tuple(sub.agent for sub in config.subagents),
    )


__all__ = [
    "SCHEMA_VERSION",
    "AgentConfig",
    "AgentModelRef",
    "AgentModelSettings",
    "CapToolConfig",
    "SubagentConfig",
    "ToolConfig",
    "config_refs",
    "dump_config",
    "empty_config",
    "load_config",
    "parse_config",
    "problems_from_errors",
]
