"""MCP 工具的卡头：标题是服务名称，主语是工具说明的第一句（过长取分句或截断），没说明时是工具名；名册里没有
这个服务时标题是「MCP 服务」。投影时按名册当下的内容画。"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest

from agent_runtime.assembly.displays import (
    MAX_TOOL_BRIEF_CHARS,
    UNKNOWN_MCP_SERVER,
    build_display_registry,
)
from agent_runtime.config.mcp_servers.public import McpServerIndex, McpServerRecord, McpTool
from agent_runtime.transcript.display import GenericDisplay

NOW = datetime(2026, 11, 1, tzinfo=UTC)
BY = uuid.uuid4()


def server(name: str, *tools: McpTool, server_id: str = "docs") -> McpServerRecord:
    return McpServerRecord(
        id=server_id,
        name=name,
        description="",
        url="https://mcp.example.com/mcp",
        transport="streamable_http",
        timeout_seconds=30,
        headers=(),
        enabled=True,
        check=None,
        tools=tools,
        created_by=BY,
        updated_by=BY,
        created_at=NOW,
        updated_at=NOW,
    )


def card(index: McpServerIndex, name: str) -> GenericDisplay:
    display = build_display_registry({}, index).tool_display(name, '{"q": "周报"}')
    assert isinstance(display, GenericDisplay)
    return display


def test_a_described_tool_shows_the_server_name_and_the_description() -> None:
    index = McpServerIndex()
    index.put(server("飞书文档", McpTool(name="search", description="搜索云文档。")))

    assert card(index, "mcp_docs_search") == GenericDisplay(summary="飞书文档", detail="搜索云文档")


@pytest.mark.parametrize(
    ("description", "detail"),
    [
        ("Add two integers.", "Add two integers"),
        # 第一句之后的不要；版本号里的点不算句末。
        ("Search docs in v1.2 spaces. Returns titles and links.", "Search docs in v1.2 spaces"),
        ("搜索云文档！\n结果按更新时间排", "搜索云文档"),
        # 第一句太长：取第一个分句。
        (
            "搜索飞书云文档，按关键词匹配标题与正文并按更新时间从新到旧排列，最多交回二十条结果，"
            "可以按知识空间筛选",
            "搜索飞书云文档",
        ),
    ],
)
def test_the_description_is_cut_to_its_first_sentence_or_clause(
    description: str, detail: str
) -> None:
    index = McpServerIndex()
    index.put(server("飞书文档", McpTool(name="search", description=description)))

    assert card(index, "mcp_docs_search").detail == detail


def test_a_long_description_without_a_clause_break_is_truncated() -> None:
    index = McpServerIndex()
    long = "Search " + "very " * 20 + "deep"
    index.put(server("飞书文档", McpTool(name="search", description=long)))

    detail = card(index, "mcp_docs_search").detail
    assert detail is not None
    assert len(detail) == MAX_TOOL_BRIEF_CHARS
    assert detail.startswith("Search very")
    assert detail.endswith("…")


@pytest.mark.parametrize("description", [None, "", "   "])
def test_a_tool_without_a_description_shows_its_name(description: str | None) -> None:
    index = McpServerIndex()
    index.put(server("飞书文档", McpTool(name="read", description=description)))

    assert card(index, "mcp_docs_read") == GenericDisplay(summary="飞书文档", detail="read")


def test_a_tool_the_index_has_not_seen_shows_its_name() -> None:
    index = McpServerIndex()
    index.put(server("飞书文档"))

    assert card(index, "mcp_docs_search") == GenericDisplay(summary="飞书文档", detail="search")


def test_an_unknown_server_falls_back_to_a_generic_title() -> None:
    index = McpServerIndex()
    index.put(server("飞书文档", McpTool(name="search", description="搜索云文档。")))

    assert card(index, "mcp_gone_search") == GenericDisplay(
        summary=UNKNOWN_MCP_SERVER, detail="search"
    )


def test_the_card_follows_the_index_as_it_changes() -> None:
    index = McpServerIndex()
    registry = build_display_registry({}, index)
    index.put(server("飞书文档", McpTool(name="search", description="搜索云文档。")))
    assert registry.tool_display("mcp_docs_search", None) == GenericDisplay(
        summary="飞书文档", detail="搜索云文档"
    )

    index.put(server("云文档", McpTool(name="search", description="搜索云文档。")))
    assert registry.tool_display("mcp_docs_search", None) == GenericDisplay(
        summary="云文档", detail="搜索云文档"
    )

    index.remove("docs")
    assert registry.tool_display("mcp_docs_search", None) == GenericDisplay(
        summary=UNKNOWN_MCP_SERVER, detail="search"
    )


def test_names_outside_the_mcp_form_fall_back_to_the_tool_name() -> None:
    assert build_display_registry({}, McpServerIndex()).tool_display(
        "unknown_tool", None
    ) == GenericDisplay(summary="unknown_tool")
