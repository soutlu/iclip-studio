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
        raise InvalidPath(f"路径 {path!r} 包含控制字符")
    if "\\" in value:
        raise InvalidPath(f"路径 {path!r} 包含反斜杠，请使用 / 分隔")
    while "//" in value:
        value = value.replace("//", "/")
    value = value.removeprefix("/")
    if value.endswith("/"):
        raise InvalidPath(f"路径 {path!r} 以 / 结尾；路径须指向文件而非目录")
    if not value:
        raise InvalidPath("路径不可为空")
    if len(value) > MAX_PATH_CHARS:
        raise InvalidPath(f"路径 {path!r} 长度超出 {MAX_PATH_CHARS} 个字符")
    segments = value.split("/")
    if len(segments) > MAX_SEGMENTS:
        raise InvalidPath(f"路径 {path!r} 目录层级超出 {MAX_SEGMENTS} 层")
    for segment in segments:
        if segment in (".", ".."):
            raise InvalidPath(f"路径 {path!r} 不可包含 . 或 ..")
        if len(segment) > MAX_SEGMENT_CHARS:
            raise InvalidPath(f"路径 {path!r} 中存在超出 {MAX_SEGMENT_CHARS} 个字符的目录或文件名")
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
