"""Agent 配置格式：不收未知字段与不认识的 type，同一工具集、同一子 agent 不能写两次，问题的 path 指到字段。"""

from __future__ import annotations

from typing import Any

from agent_runtime.config.agent_config.config import AgentConfig, parse_config
from agent_runtime.config.agent_config.models import Problem


def config(**fields: Any) -> dict[str, Any]:
    return {"schema_version": 1, **fields}


def problems_of(raw: object) -> tuple[Problem, ...]:
    parsed = parse_config(raw)
    assert not isinstance(parsed, AgentConfig), parsed
    return parsed


def test_unknown_fields_are_refused_with_their_path() -> None:
    found = problems_of(
        config(
            colour="red",
            model={"provider": "acme", "name": "m1", "settings": {"temperature": 1}},
            tools=[{"type": "cap", "toolset": "notes", "extra": True}],
        )
    )

    assert {one.path for one in found} == {
        "colour",
        "model.settings.temperature",
        "tools[0].extra",
    }


def test_repeated_toolset_is_refused() -> None:
    (found,) = problems_of(
        config(
            tools=[
                {"type": "cap", "toolset": "notes"},
                {"type": "cap", "toolset": "search"},
                {"type": "cap", "toolset": "notes", "enabled": False},
            ]
        )
    )

    assert found.path == "tools"
    assert "第 3 项" in found.message


def test_repeated_subagent_is_refused() -> None:
    (found,) = problems_of(config(subagents=[{"agent": "helper"}, {"agent": "helper"}]))

    assert found.path == "subagents"
