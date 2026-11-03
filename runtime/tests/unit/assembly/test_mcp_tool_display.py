"""MCP 工具的卡头：标题是服务名称，主语是服务给的工具显示名，没给就没有主语；工具说明与工具名都不上卡头。
名册里没有这个服务时标题是「MCP 服务」。投影时按名册当下的内容画。"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from agent_runtime.assembly.displays import UNKNOWN_MCP_SERVER, build_display_registry
from agent_runtime.config.mcp_servers.public import McpServerIndex, McpServerRecord, McpTool
from agent_runtime.transcript.display import GenericDisplay

NOW = datetime(2026, 11, 1, tzinfo=UTC)
BY = uuid.uuid4()


def server(name: str, *tools: McpTool, server_id: str = "docs") -> McpServerRecord:
    return McpServerRecord(
        id=server_id,
        name=name,
        description="",
        # 名册只看名称与工具，地址的密文与哈希用不到。
        url="ciphertext",
        url_hash="url-hash",
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


def test_a_titled_tool_shows_the_server_name_and_the_title() -> None:
    index = McpServerIndex()
    index.put(
        server("知识库", McpTool(name="read", title="读取原文", description="根据引用读取原文。"))
    )

    assert card(index, "mcp_docs_read") == GenericDisplay(summary="知识库", detail="读取原文")


def test_a_tool_without_a_title_shows_only_the_server_name() -> None:
    index = McpServerIndex()
    index.put(
        server(
            "知识库",
            McpTool(
                name="read",
                title=None,
                description="根据知识库返回的引用读取原文，获取指定页或文档的文字、表格和图片。",
            ),
        )
    )

    assert card(index, "mcp_docs_read") == GenericDisplay(summary="知识库")


def test_a_tool_the_index_has_not_seen_shows_only_the_server_name() -> None:
    index = McpServerIndex()
    index.put(server("知识库"))

    assert card(index, "mcp_docs_search") == GenericDisplay(summary="知识库")


def test_an_unknown_server_shows_a_generic_title_without_the_tool_name() -> None:
    index = McpServerIndex()
    index.put(server("知识库", McpTool(name="search", title="检索资料", description=None)))

    assert card(index, "mcp_gone_search") == GenericDisplay(summary=UNKNOWN_MCP_SERVER)


def test_the_card_follows_the_index_as_it_changes() -> None:
    index = McpServerIndex()
    registry = build_display_registry({}, index)
    index.put(server("知识库", McpTool(name="search", title="检索资料", description=None)))
    assert registry.tool_display("mcp_docs_search", None) == GenericDisplay(
        summary="知识库", detail="检索资料"
    )

    index.put(server("资料库", McpTool(name="search", title="查找资料", description=None)))
    assert registry.tool_display("mcp_docs_search", None) == GenericDisplay(
        summary="资料库", detail="查找资料"
    )

    index.remove("docs")
    assert registry.tool_display("mcp_docs_search", None) == GenericDisplay(
        summary=UNKNOWN_MCP_SERVER
    )


def test_names_outside_the_mcp_form_fall_back_to_the_tool_name() -> None:
    assert build_display_registry({}, McpServerIndex()).tool_display(
        "unknown_tool", None
    ) == GenericDisplay(summary="unknown_tool")
