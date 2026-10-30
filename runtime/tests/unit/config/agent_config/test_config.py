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


def test_full_config_parses_with_defaults() -> None:
    parsed = parse_config(
        config(
            instructions="你是导演",
            model={"provider": "acme", "name": "m1", "settings": {"thinking": "high"}},
            tools=[{"type": "cap", "toolset": "notes"}],
            subagents=[{"agent": "helper", "timeout_seconds": 600, "max_calls": 2}],
        )
    )

    assert isinstance(parsed, AgentConfig)
    assert parsed.model is not None and parsed.model.credential_id is None
    assert parsed.tools[0].enabled is True and parsed.tools[0].parameters == {}
    assert parsed.subagents[0].on_failure is None


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


def test_unknown_tool_type_is_refused() -> None:
    (found,) = problems_of(config(tools=[{"type": "mcp", "url": "http://x"}]))

    assert found.path == "tools[0]"
    assert "mcp" in found.message


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


def test_wrong_schema_version_and_bad_limits_are_refused() -> None:
    found = problems_of(
        {"schema_version": 2, "subagents": [{"agent": "helper", "timeout_seconds": 0}]}
    )

    assert {one.path for one in found} == {"schema_version", "subagents[0].timeout_seconds"}
