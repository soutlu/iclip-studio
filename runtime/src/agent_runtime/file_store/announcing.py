from __future__ import annotations

import uuid
from collections.abc import Callable, Sequence
from typing import Literal

from agent_runtime.file_store.namespace import parse_namespace
from agent_runtime.file_store.store import FileEntry, FileStore, SearchResult, StoredFile

FileChange = Literal["created", "modified", "deleted"]

AnnounceFileChange = Callable[[uuid.UUID, uuid.UUID, str, FileChange], None]


class AnnouncingFileStore:
    def __init__(self, inner: FileStore, announce: AnnounceFileChange) -> None:
        self._inner = inner
        self._announce_change = announce

    async def read(self, namespace: str, path: str) -> StoredFile | None:
        return await self._inner.read(namespace, path)

    async def write(
        self, namespace: str, path: str, content: str, *, expected_version: int | None = None
    ) -> FileEntry:
        entry = await self._inner.write(namespace, path, content, expected_version=expected_version)
        self._announce(namespace, entry.path, "created" if entry.version == 1 else "modified")
        return entry

    async def delete(self, namespace: str, path: str) -> bool:
        deleted = await self._inner.delete(namespace, path)
        if deleted:
            self._announce(namespace, path, "deleted")
        return deleted

    async def entries(self, namespace: str, *, prefix: str = "") -> Sequence[FileEntry]:
        return await self._inner.entries(namespace, prefix=prefix)

    async def search(self, namespace: str, query: str, *, limit: int) -> SearchResult:
        return await self._inner.search(namespace, query, limit=limit)

    def _announce(self, namespace: str, path: str, change: FileChange) -> None:
        try:
            owner, session_id = parse_namespace(namespace)
        except ValueError:
            return
        self._announce_change(owner, session_id, path, change)


__all__ = ["AnnounceFileChange", "AnnouncingFileStore", "FileChange"]
