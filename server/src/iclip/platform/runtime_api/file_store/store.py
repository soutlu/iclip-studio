from __future__ import annotations

import unicodedata
from dataclasses import dataclass
from datetime import datetime

MAX_PATH_CHARS = 512
MAX_SEGMENTS = 16
MAX_SEGMENT_CHARS = 128


class FileStoreError(Exception):
    pass


class InvalidPath(FileStoreError):
    pass


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


__all__ = [
    "MAX_PATH_CHARS",
    "MAX_SEGMENTS",
    "MAX_SEGMENT_CHARS",
    "FileEntry",
    "FileStoreError",
    "InvalidPath",
    "StoredFile",
    "normalize_path",
]
