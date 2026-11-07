from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

import pytest

from cue.assembly.displays import UNKNOWN_MCP_SERVER, build_display_registry
from cue.config.mcp_servers.public import McpServerIndex, McpServerRecord, McpTool
from cue.transcript.display import GenericDisplay

NOW = datetime(2026, 11, 1, tzinfo=UTC)
BY = uuid.uuid4()


def server(name: str, *tools: McpTool, server_id: str = "docs") -> McpServerRecord:
    return McpServerRecord(
        id=server_id,
        name=name,
        description="",
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


def card(index: McpServerIndex, name: str, args: Any = '{"ref": "kb1.page-63"}') -> GenericDisplay:
    display = build_display_registry({}, index).tool_display(name, args)
    assert isinstance(display, GenericDisplay)
    return display


def knowledge(title: str | None = None) -> McpServerIndex:
    index = McpServerIndex()
    index.put(
        server(
            "知识库",
            McpTool(
                name="read",
                title=title,
                description="根据知识库返回的引用读取原文，获取指定页或文档的文字、表格和图片。",
            ),
        )
    )
    return index


def test_a_titled_tool_shows_the_server_name_the_title_and_the_key_argument() -> None:
    assert card(knowledge("读取原文"), "mcp_docs_read") == GenericDisplay(
        summary="知识库 · 读取原文", detail="kb1.page-63"
    )


def test_a_tool_without_a_title_shows_the_server_name_and_the_key_argument() -> None:
    assert card(knowledge(), "mcp_docs_read") == GenericDisplay(
        summary="知识库", detail="kb1.page-63"
    )


@pytest.mark.parametrize(
    ("args", "detail"),
    [
        ({"query": "酒红 乐福鞋"}, "酒红 乐福鞋"),
        ({"limit": 5, "ref": "kb1.page-63"}, "kb1.page-63"),
        ({"note": "", "blank": "  ", "text": "第一行\n第二行"}, "第一行"),
        ('{"query": "春夏 面料"}', "春夏 面料"),
        ({"content": [{"type": "text", "text": "酒红"}]}, None),
        ({"a": 2, "b": 3}, None),
        ('{"query": "酒', None),
        (None, None),
    ],
)
def test_the_key_argument_is_the_first_non_empty_top_level_string(
    args: Any, detail: str | None
) -> None:
    assert card(knowledge(), "mcp_docs_read", args).detail == detail


def test_a_tool_the_index_has_not_seen_shows_the_server_name() -> None:
    index = McpServerIndex()
    index.put(server("知识库"))

    assert card(index, "mcp_docs_search") == GenericDisplay(summary="知识库", detail="kb1.page-63")


def test_an_unknown_server_shows_a_generic_title_and_the_key_argument() -> None:
    assert card(knowledge("读取原文"), "mcp_gone_read") == GenericDisplay(
        summary=UNKNOWN_MCP_SERVER, detail="kb1.page-63"
    )


def test_the_card_follows_the_index_as_it_changes() -> None:
    index = McpServerIndex()
    registry = build_display_registry({}, index)
    index.put(server("知识库", McpTool(name="search", title="检索资料", description=None)))
    assert registry.tool_display("mcp_docs_search", None) == GenericDisplay(
        summary="知识库 · 检索资料"
    )

    index.put(server("资料库", McpTool(name="search", title=None, description=None)))
    assert registry.tool_display("mcp_docs_search", None) == GenericDisplay(summary="资料库")

    index.remove("docs")
    assert registry.tool_display("mcp_docs_search", None) == GenericDisplay(
        summary=UNKNOWN_MCP_SERVER
    )


def test_names_outside_the_mcp_form_fall_back_to_the_tool_name() -> None:
    assert build_display_registry({}, McpServerIndex()).tool_display(
        "unknown_tool", None
    ) == GenericDisplay(summary="unknown_tool")
