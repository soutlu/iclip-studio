from __future__ import annotations

import unicodedata
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal, Protocol

MAX_PATH_CHARS = 512
MAX_SEGMENTS = 16
MAX_SEGMENT_CHARS = 128

DEFAULT_MAX_FILE_BYTES = 1_000_000

DEFAULT_MAX_NAMESPACE_BYTES = 20_000_000

MAX_SEARCH_FILES = 200

MAX_MATCHES_PER_FILE = 3

MAX_SNIPPET_CHARS = 200


class FileStoreError(Exception):
    pass


class InvalidPath(FileStoreError):
    pass


class InvalidContent(FileStoreError):
    pass


class VersionConflict(FileStoreError):
    def __init__(self, path: str, *, expected: int, actual: int | None) -> None:
        if actual is None:
            super().__init__(f"{path} 已经被删除了（期望版本 {expected}）")
        else:
            super().__init__(f"{path} 已经被改过：期望版本 {expected}，实际 {actual}")
        self.path = path
        self.expected = expected
        self.actual = actual


class QuotaExceeded(FileStoreError):
    def __init__(
        self,
        *,
        scope: Literal["file", "namespace"],
        attempted: int,
        limit: int,
        path: str | None = None,
    ) -> None:
        if scope == "file":
            super().__init__(f"{path} 会变成 {attempted} 字节，超过单文件上限 {limit} 字节")
        else:
            super().__init__(f"工作区会占用 {attempted} 字节，超过总上限 {limit} 字节")
        self.scope = scope
        self.attempted = attempted
        self.limit = limit
        self.path = path


@dataclass(frozen=True, slots=True)
class StoredFile:
    """文件全文与版本号。

    读取不截断，避免编辑工具将截断内容写回后丢失文件尾部。
    """

    path: str
    content: str
    version: int


@dataclass(frozen=True, slots=True)
class FileEntry:
    """用于目录列表与写入结果的文件元信息。"""

    path: str
    size_bytes: int
    version: int
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class SearchMatch:
    path: str
    line: int
    snippet: str


@dataclass(frozen=True, slots=True)
class SearchResult:
    matches: tuple[SearchMatch, ...]
    truncated: bool


def normalize_path(path: str) -> str:
    value = unicodedata.normalize("NFC", path)
    if any(unicodedata.category(ch) == "Cc" for ch in value):
        raise InvalidPath(f"路径 {path!r} 里有控制字符")
    if "\\" in value:
        raise InvalidPath(f"路径 {path!r} 用了反斜杠，请用 /")
    while "//" in value:
        value = value.replace("//", "/")
    value = value.removeprefix("/")
    if value.endswith("/"):
        raise InvalidPath(f"路径 {path!r} 以 / 结尾；路径指向文件，不是目录")
    if not value:
        raise InvalidPath("路径是空的")
    if len(value) > MAX_PATH_CHARS:
        raise InvalidPath(f"路径 {path!r} 超过 {MAX_PATH_CHARS} 个字符")
    segments = value.split("/")
    if len(segments) > MAX_SEGMENTS:
        raise InvalidPath(f"路径 {path!r} 超过 {MAX_SEGMENTS} 层")
    for segment in segments:
        if segment in (".", ".."):
            raise InvalidPath(f"路径 {path!r} 里不许出现 . 或 .. 这样的段")
        if len(segment) > MAX_SEGMENT_CHARS:
            raise InvalidPath(f"路径 {path!r} 有一段超过 {MAX_SEGMENT_CHARS} 个字符")
    return value


def validate_content(content: str) -> None:
    if "\x00" in content:
        raise InvalidContent("内容里有 NUL 字节（\\x00），存不进去；把它去掉再写。")


def build_matches(
    files: Iterable[tuple[str, str]], query: str, *, limit: int
) -> tuple[SearchMatch, ...]:
    needle = query.lower()
    matches: list[SearchMatch] = []
    for path, content in files:
        hits = 0
        for number, line in enumerate(content.splitlines(), start=1):
            if needle not in line.lower():
                continue
            snippet = line.strip()
            if len(snippet) > MAX_SNIPPET_CHARS:
                snippet = snippet[:MAX_SNIPPET_CHARS] + "…"
            matches.append(SearchMatch(path=path, line=number, snippet=snippet))
            hits += 1
            if hits >= MAX_MATCHES_PER_FILE or len(matches) >= limit:
                break
        if len(matches) >= limit:
            break
    return tuple(matches)


class FileStore(Protocol):
    async def read(self, namespace: str, path: str) -> StoredFile | None: ...

    async def write(
        self, namespace: str, path: str, content: str, *, expected_version: int | None = None
    ) -> FileEntry: ...

    async def delete(self, namespace: str, path: str) -> bool: ...

    async def entries(self, namespace: str, *, prefix: str = "") -> Sequence[FileEntry]: ...

    async def search(self, namespace: str, query: str, *, limit: int) -> SearchResult: ...


@dataclass(frozen=True, slots=True)
class FileSpace:
    store: FileStore

    namespace: Callable[[Any], str]

    def resolve(self, ctx: Any) -> str:
        return normalize_path(self.namespace(ctx))


__all__ = [
    "DEFAULT_MAX_FILE_BYTES",
    "DEFAULT_MAX_NAMESPACE_BYTES",
    "MAX_MATCHES_PER_FILE",
    "MAX_PATH_CHARS",
    "MAX_SEARCH_FILES",
    "MAX_SEGMENTS",
    "MAX_SEGMENT_CHARS",
    "MAX_SNIPPET_CHARS",
    "FileEntry",
    "FileSpace",
    "FileStore",
    "FileStoreError",
    "InvalidContent",
    "InvalidPath",
    "QuotaExceeded",
    "SearchMatch",
    "SearchResult",
    "StoredFile",
    "VersionConflict",
    "build_matches",
    "normalize_path",
    "validate_content",
]
