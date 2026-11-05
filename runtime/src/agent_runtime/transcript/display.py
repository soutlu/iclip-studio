from __future__ import annotations

import json
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from typing import (
    Any,
    ClassVar,
    Final,
    Literal,
    NotRequired,
    TypedDict,
)
from urllib.parse import unquote, urlsplit

from pydantic import BaseModel, ConfigDict


class _Display(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class FileIoDisplay(_Display):
    kind: Literal["file_io"] = "file_io"
    operation: Literal["read", "write", "edit", "glob", "grep"]
    path: str
    content: str | None = None
    before: str | None = None
    after: str | None = None


class SearchDisplay(_Display):
    kind: Literal["search"] = "search"
    query: str
    scope: str | None = None


class UrlFetchDisplay(_Display):
    kind: Literal["url_fetch"] = "url_fetch"
    url: str


class SkillCallDisplay(_Display):
    kind: Literal["skill_call"] = "skill_call"
    skill_name: str
    args: str | None = None


class AgentCallDisplay(_Display):
    kind: Literal["agent_call"] = "agent_call"
    agent_name: str
    prompt: str


class GenericDisplay(_Display):
    kind: Literal["generic"] = "generic"
    summary: str
    detail: str | None = None


ToolDisplay = (
    FileIoDisplay
    | SearchDisplay
    | UrlFetchDisplay
    | SkillCallDisplay
    | AgentCallDisplay
    | GenericDisplay
)

DisplayFn = Callable[[Any], ToolDisplay | None]

NamedDisplayFn = Callable[[str, Any], ToolDisplay | None]


FILE_CONTENT_VIEW: Final = "file_content"

SEARCH_RESULTS_VIEW: Final = "search_results"

MEDIA_GRID_VIEW: Final = "media_grid"


class FileContentMeta(TypedDict):
    path: str
    lines: int
    truncated: bool


def file_content(path: str, *, lines: int, truncated: bool) -> FileContentMeta:
    return {"path": path, "lines": lines, "truncated": truncated}


class SearchMatch(TypedDict):
    file: str
    line: int
    text: str


class SearchResultsMeta(TypedDict):
    query: str
    matches: list[SearchMatch]
    truncated: bool


def search_results(
    query: str, matches: Iterable[tuple[str, int, str]], *, truncated: bool
) -> SearchResultsMeta:
    return {
        "query": query,
        "matches": [SearchMatch(file=file, line=line, text=text) for file, line, text in matches],
        "truncated": truncated,
    }


class MediaGridItem(TypedDict):
    url: str
    caption: NotRequired[str]


class MediaGridItems(TypedDict):
    items: list[MediaGridItem]
    note: NotRequired[str]


def media_grid(
    items: Iterable[tuple[str, str | None]], *, note: str | None = None
) -> MediaGridItems:
    grid: MediaGridItems = {"items": []}
    for url, caption in items:
        item: MediaGridItem = {"url": url}
        if caption is not None:
            item["caption"] = caption
        grid["items"].append(item)
    if note is not None:
        grid["note"] = note
    return grid


class ToolNote(TypedDict, total=False):
    chip: str
    added: int
    removed: int
    body: Literal["none"]


def tool_note(chip: str | None = None, *, body: Literal["none"] | None = None) -> ToolNote:
    note: ToolNote = {}
    if chip is not None:
        note["chip"] = chip
    if body is not None:
        note["body"] = body
    return note


def diff_note(added: int, removed: int) -> ToolNote:
    return {"added": added, "removed": removed}


def url_filename(url: str) -> str | None:
    path = urlsplit(url).path
    name = unquote(path.rsplit("/", 1)[-1]) if path else ""
    return name or None


def _as_mapping(args: Any) -> Any:
    if not isinstance(args, str):
        return args
    try:
        return json.loads(args)
    except json.JSONDecodeError:
        return None


@dataclass(frozen=True, slots=True)
class ToolDisplayEntry:
    draw: DisplayFn
    view: str | None = None


@dataclass(frozen=True, slots=True)
class ToolDisplayRegistry:
    entries: Mapping[str, ToolDisplayEntry]
    unlisted: NamedDisplayFn | None = None

    EMPTY: ClassVar[ToolDisplayRegistry]

    def tool_display(self, name: str, args: Any) -> ToolDisplay:
        entry = self.entries.get(name)
        if entry is not None:
            display = entry.draw(_as_mapping(args))
            if display is not None:
                return display
        elif self.unlisted is not None:
            display = self.unlisted(name, _as_mapping(args))
            if display is not None:
                return display
        return GenericDisplay(summary=name)

    def view_of(self, name: str) -> str | None:
        entry = self.entries.get(name)
        return None if entry is None else entry.view

    @staticmethod
    def merged(
        *tables: Mapping[str, DisplayFn | ToolDisplayEntry], unlisted: NamedDisplayFn | None = None
    ) -> ToolDisplayRegistry:
        entries: dict[str, ToolDisplayEntry] = {}
        for table in tables:
            for name, registered in table.items():
                if name in entries:
                    raise ValueError(f"工具 {name!r} 的画法登记了两遍；一件工具只归一个能力。")
                entries[name] = (
                    registered
                    if isinstance(registered, ToolDisplayEntry)
                    else ToolDisplayEntry(draw=registered)
                )
        return ToolDisplayRegistry(entries, unlisted)


ToolDisplayRegistry.EMPTY = ToolDisplayRegistry({})


__all__ = [
    "FILE_CONTENT_VIEW",
    "MEDIA_GRID_VIEW",
    "SEARCH_RESULTS_VIEW",
    "AgentCallDisplay",
    "DisplayFn",
    "FileContentMeta",
    "FileIoDisplay",
    "GenericDisplay",
    "MediaGridItem",
    "MediaGridItems",
    "NamedDisplayFn",
    "SearchDisplay",
    "SearchMatch",
    "SearchResultsMeta",
    "SkillCallDisplay",
    "ToolDisplay",
    "ToolDisplayEntry",
    "ToolDisplayRegistry",
    "ToolNote",
    "UrlFetchDisplay",
    "diff_note",
    "file_content",
    "media_grid",
    "search_results",
    "tool_note",
    "url_filename",
]
