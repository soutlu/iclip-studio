"""写完就通知的文件存储：会话工作区里新写报 created、再写报 modified、真删了报 deleted；没删到、写失败与
会话以外的命名空间都不报。"""

from __future__ import annotations

import uuid

import pytest

from agent_runtime.file_store.announcing import AnnouncingFileStore, FileChange
from agent_runtime.file_store.namespace import namespace_for
from agent_runtime.file_store.store import VersionConflict
from tests.helpers.file_store import FakeFileStore

OWNER = uuid.UUID("6f1d8a4e-2b7c-4e0a-9d51-3c2f7e8b9a10")
SESSION = uuid.UUID("0b8e9f4c-6a1d-4f2e-9c3b-5d7a1e2f3c4d")
NAMESPACE = namespace_for(OWNER, str(SESSION))

Announced = list[tuple[uuid.UUID, uuid.UUID, str, FileChange]]


def announcing() -> tuple[AnnouncingFileStore, Announced]:
    heard: Announced = []

    def announce(owner: uuid.UUID, session: uuid.UUID, path: str, change: FileChange) -> None:
        heard.append((owner, session, path, change))

    return AnnouncingFileStore(FakeFileStore(), announce), heard


async def test_writes_and_deletes_in_a_session_workspace_are_announced() -> None:
    store, heard = announcing()

    await store.write(NAMESPACE, "notes/a.md", "一")
    await store.write(NAMESPACE, "notes/a.md", "二")
    assert await store.delete(NAMESPACE, "notes/a.md")
    assert not await store.delete(NAMESPACE, "notes/a.md")

    assert heard == [
        (OWNER, SESSION, "notes/a.md", "created"),
        (OWNER, SESSION, "notes/a.md", "modified"),
        (OWNER, SESSION, "notes/a.md", "deleted"),
    ]


async def test_a_failed_write_announces_nothing() -> None:
    store, heard = announcing()

    with pytest.raises(VersionConflict):
        await store.write(NAMESPACE, "a.md", "一", expected_version=3)

    assert heard == []


async def test_namespaces_outside_sessions_announce_nothing() -> None:
    store, heard = announcing()

    await store.write("library/brand", "a.md", "一")
    await store.delete("library/brand", "a.md")

    assert heard == []
