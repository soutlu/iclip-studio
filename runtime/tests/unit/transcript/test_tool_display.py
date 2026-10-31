"""验证工具 display 注册、generic 回退及重复名称检测。"""

from __future__ import annotations

from typing import Any

import pytest

from agent_runtime.transcript.display import (
    FileIoDisplay,
    GenericDisplay,
    ToolDisplay,
    ToolDisplayRegistry,
    url_filename,
)


def _read(args: Any) -> ToolDisplay | None:
    path = args.get("path") if isinstance(args, dict) else None
    return FileIoDisplay(operation="read", path=path) if isinstance(path, str) and path else None


REGISTRY = ToolDisplayRegistry.merged({"read_file": _read})


def test_an_unregistered_tool_falls_back_to_generic() -> None:

    assert REGISTRY.tool_display("write_file", {"path": "a.md"}) == GenericDisplay(
        summary="write_file"
    )


def test_a_table_that_cannot_work_it_out_falls_back_to_generic() -> None:

    assert REGISTRY.tool_display("read_file", {}) == GenericDisplay(summary="read_file")


def test_json_string_arguments_are_parsed() -> None:
    """流式消息中的工具参数可能为 JSON 字符串，需要解析。"""

    assert REGISTRY.tool_display("read_file", '{"path": "shots.md"}') == FileIoDisplay(
        operation="read", path="shots.md"
    )


def test_unparseable_arguments_fall_back_to_generic() -> None:

    assert REGISTRY.tool_display("read_file", '{"path": ') == GenericDisplay(summary="read_file")


def test_merging_two_tables_with_the_same_tool_fails_at_assembly() -> None:

    with pytest.raises(ValueError, match="read_file"):
        ToolDisplayRegistry.merged({"read_file": _read}, {"read_file": _read})


@pytest.mark.parametrize(
    ("url", "name"),
    [
        ("https://cdn.test/a/ref.mp4", "ref.mp4"),
        ("https://cdn.test/a/%E5%A4%9C%E6%99%AF.png?x-oss-process=image", "夜景.png"),
        ("https://cdn.test/", None),
        ("https://cdn.test", None),
    ],
)
def test_the_subject_of_a_url_is_its_file_name(url: str, name: str | None) -> None:

    assert url_filename(url) == name
