"""MCP 工具在 agent 里的名字：``mcp_<服务标识>_<工具名>``，能拆回服务与工具。"""

from __future__ import annotations

import pytest

from agent_runtime.config.agent_config.models import (
    mcp_tool_name,
    mcp_tool_prefix,
    split_mcp_tool_name,
)


def test_the_name_is_the_prefix_and_the_servers_own_tool_name() -> None:
    assert mcp_tool_prefix("my-files") == "mcp_my-files"
    assert mcp_tool_name("my-files", "read_file") == "mcp_my-files_read_file"


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("mcp_calc_add", ("calc", "add")),
        # 服务标识里没有下划线，第一个下划线之后都是工具名。
        ("mcp_my-files_read_file", ("my-files", "read_file")),
        ("read_file", None),
        ("mcp_calc", None),
        ("mcp__add", None),
        ("mcp_calc_", None),
    ],
)
def test_names_split_back_into_server_and_tool(name: str, expected: tuple[str, str] | None) -> None:
    assert split_mcp_tool_name(name) == expected
