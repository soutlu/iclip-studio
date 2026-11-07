from __future__ import annotations

from collections.abc import Sequence
from typing import Protocol

from cue.app_wire import FileWriteIn
from cue.client import RuntimeClient
from cue.errors import NotFound
from cue.file_store.namespace import parse_namespace
from cue.file_store.store import FileEntry, StoredFile


class WorkspaceFiles(Protocol):
    async def read(self, namespace: str, path: str) -> StoredFile | None: ...

    async def write(
        self, namespace: str, path: str, content: str, *, expected_version: int | None = None
    ) -> FileEntry: ...

    async def entries(self, namespace: str, *, prefix: str = "") -> Sequence[FileEntry]: ...


class RuntimeFiles:
    def __init__(self, client: RuntimeClient) -> None:
        self._client = client

    async def read(self, namespace: str, path: str) -> StoredFile | None:
        owner, conversation_id = parse_namespace(namespace)
        try:
            return await self._client.read_file(conversation_id, path, owner=owner)
        except NotFound:
            return None

    async def write(
        self, namespace: str, path: str, content: str, *, expected_version: int | None = None
    ) -> FileEntry:
        owner, conversation_id = parse_namespace(namespace)
        return await self._client.write_file(
            conversation_id,
            path,
            FileWriteIn(content=content, expected_version=expected_version),
            owner=owner,
        )

    async def entries(self, namespace: str, *, prefix: str = "") -> Sequence[FileEntry]:
        owner, conversation_id = parse_namespace(namespace)
        return (await self._client.list_files(conversation_id, owner=owner, prefix=prefix)).files


__all__ = ["RuntimeFiles", "WorkspaceFiles"]
