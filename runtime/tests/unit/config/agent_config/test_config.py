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


def test_mcp_entry_names_a_server_and_all_or_some_of_its_tools() -> None:
    parsed = parse_config(
        config(
            tools=[
                {"type": "mcp", "server": "calc", "tools": ["add"]},
                {"type": "mcp", "server": "files", "tools": None},
                {"type": "cap", "toolset": "calc"},
            ]
        )
    )

    assert isinstance(parsed, AgentConfig)
    assert [getattr(tool, "tools", "-") for tool in parsed.tools] == [("add",), None, "-"]


def test_mcp_entry_structure_problems_point_at_the_field() -> None:
    found = problems_of(
        config(
            tools=[
                {"type": "mcp", "server": "calc", "tools": []},
                {"type": "mcp", "server": "files", "tools": ["read", "read"]},
                {"type": "mcp", "tools": None, "enabled": True},
            ]
        )
    )

    assert {one.path for one in found} == {
        "tools[0].tools",
        "tools[1].tools",
        "tools[2].server",
        "tools[2].enabled",
    }


def test_same_mcp_server_twice_is_refused() -> None:
    (found,) = problems_of(
        config(
            tools=[
                {"type": "mcp", "server": "calc"},
                {"type": "mcp", "server": "calc", "tools": ["add"]},
            ]
        )
    )

    assert found.path == "tools"
    assert "MCP 服务 calc" in found.message
