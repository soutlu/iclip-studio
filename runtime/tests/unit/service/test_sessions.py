"""会话服务中需要替身控制的竞争与失败边界；正常分叉、文件拷贝与应用隔离由真实 PG / HTTP 测试覆盖。

保留源在规划前变化、无效 agent、无前置条件拷贝，以及归属校验早于其他读取和写入的断言。
"""

from __future__ import annotations

import uuid
from collections.abc import Collection
from dataclasses import dataclass, field

import pytest

from agent_runtime.errors import Conflict, NotFound, ValidationFailed
from agent_runtime.file_store.namespace import namespace_for
from agent_runtime.file_store.store import StoredFile
from agent_runtime.harness.jobs import JobQueueView
from agent_runtime.material_ledger.store import Material
from agent_runtime.service.sessions import (
    SESSION_ID_TAKEN,
    SESSION_NOT_FOUND,
    SessionQueue,
    SessionService,
)
from tests.helpers.file_store import FakeFileStore
from tests.helpers.material_ledger import FakeMaterialLedger

APP = "video"
OTHER_APP = "shop"
SOURCE = uuid.uuid4()
TARGET = uuid.uuid4()
SOURCE_USER = uuid.uuid4()
TARGET_USER = uuid.uuid4()
SOURCE_SPACE = namespace_for(SOURCE_USER, str(SOURCE))
TARGET_SPACE = namespace_for(TARGET_USER, str(TARGET))
ASSISTANT_VERSION = uuid.uuid4()
REF = Material(url="https://example.test/ref.mp4", kind="video")


@dataclass
class RecordingSessions:
    """返回已知归属与目标占用结果，只记录是否产生写入。"""

    apps: dict[uuid.UUID, str] = field(default_factory=lambda: {SOURCE: APP, TARGET: APP})
    target_taken: bool = False
    written: bool = False

    async def open(
        self, session_id: uuid.UUID, *, app_id: str, agent_version_id: uuid.UUID | None
    ) -> bool:
        self.written = not self.target_taken
        return self.written

    async def copy(self, source_id: uuid.UUID, target_id: uuid.UUID, *, app_id: str) -> bool:
        self.written = not self.target_taken
        return self.written

    async def owned(
        self, session_ids: Collection[uuid.UUID], *, app_id: str
    ) -> frozenset[uuid.UUID]:
        return frozenset(one for one in session_ids if self.apps.get(one) == app_id)


async def current_version(agent_id: str) -> uuid.UUID:
    if agent_id != "assistant":
        raise ValidationFailed(f"没有标识为 {agent_id} 的 agent")
    return ASSISTANT_VERSION


class IdleQueue:
    async def view(self, conversation_id: str) -> JobQueueView:
        assert conversation_id == str(SOURCE)
        return JobQueueView(active=None, queued=())


@dataclass
class MovedHistory:
    """数完两轮后源又变化，无法规划可提交的分叉起点。"""

    planned: list[tuple[str, int, str]] = field(default_factory=list)

    async def turn_count(self, conversation_id: str) -> int:
        assert conversation_id == str(SOURCE)
        return 2

    async def plan_fork(
        self, conversation_id: str, *, ordinal: int, target_conversation_id: str
    ) -> None:
        self.planned.append((conversation_id, ordinal, target_conversation_id))


@dataclass
class Runtime:
    sessions: RecordingSessions = field(default_factory=RecordingSessions)
    queue: SessionQueue = field(default_factory=IdleQueue)
    history: MovedHistory = field(default_factory=MovedHistory)
    files: FakeFileStore = field(default_factory=FakeFileStore)
    ledger: FakeMaterialLedger = field(default_factory=FakeMaterialLedger)

    def service(self) -> SessionService:
        return SessionService(
            sessions=self.sessions,
            version_for_new_session=current_version,
            queue=self.queue,
            history=self.history,
            files=self.files,
            ledger=self.ledger,
        )

    async def seed_source(self, files: dict[str, str]) -> None:
        for path, content in files.items():
            await self.files.write(SOURCE_SPACE, path, content)
        await self.ledger.record(SOURCE_SPACE, [REF])

    async def target_files(self) -> dict[str, StoredFile]:
        found: dict[str, StoredFile] = {}
        for entry in await self.files.entries(TARGET_SPACE):
            stored = await self.files.read(TARGET_SPACE, entry.path)
            assert stored is not None
            found[entry.path] = stored
        return found

    async def nothing_written(self) -> bool:
        return (
            not self.sessions.written
            and not await self.files.entries(TARGET_SPACE)
            and not self.ledger.urls(TARGET_SPACE)
        )


async def fork(runtime: Runtime, *, turn: int = 1, agent_id: str | None = None) -> None:
    await runtime.service().fork(
        app_id=APP,
        source_id=SOURCE,
        source_user=SOURCE_USER,
        target_id=TARGET,
        target_user=TARGET_USER,
        turn=turn,
        agent_id=agent_id,
    )


async def test_a_source_that_moved_before_the_seed_is_a_conflict_and_nothing_is_seeded() -> None:
    runtime = Runtime()
    await runtime.seed_source({"video_shot.json": "{}"})

    with pytest.raises(Conflict) as raised:
        await fork(runtime)

    assert str(raised.value) == "这段对话刚刚又跑了一轮，重新挑一个分叉点"
    assert runtime.history.planned == [(str(SOURCE), 1, str(TARGET))]


async def test_an_agent_that_cannot_open_fails_the_fork_before_any_file_is_copied() -> None:
    runtime = Runtime()
    await runtime.seed_source({"video_shot.json": "{}"})

    with pytest.raises(ValidationFailed, match="没有标识为 gone 的 agent"):
        await fork(runtime, agent_id="gone")

    assert not await runtime.files.entries(TARGET_SPACE)


FILES = (("film.icml", "old_film.icml"), ("treatment.md", "treatment.md"))
REQUIRED = frozenset({"film.icml"})


async def copy_files(runtime: Runtime, *, require_any: frozenset[str] = REQUIRED) -> bool:
    return await runtime.service().copy_files(
        app_id=APP,
        source_id=SOURCE,
        source_user=SOURCE_USER,
        target_id=TARGET,
        target_user=TARGET_USER,
        files=FILES,
        require_any=require_any,
    )


async def test_copy_files_without_a_precondition_copies_what_the_source_has() -> None:
    runtime = Runtime()
    await runtime.seed_source({"treatment.md": "方案"})

    assert await copy_files(runtime, require_any=frozenset())

    copied = await runtime.target_files()
    assert {path: stored.content for path, stored in copied.items()} == {"treatment.md": "方案"}
    assert runtime.ledger.urls(TARGET_SPACE) == {REF.url}


class UnreadableQueue:
    """归属未确认时不得读取队列，避免向其他应用泄露会话信息。"""

    async def view(self, conversation_id: str) -> JobQueueView:
        raise AssertionError("归属校验失败前不应读取队列")


async def test_a_fork_from_another_apps_session_is_not_found_before_anything_else() -> None:
    runtime = Runtime(
        sessions=RecordingSessions(apps={SOURCE: OTHER_APP}),
        queue=UnreadableQueue(),
    )
    await runtime.seed_source({"video_shot.json": "{}"})

    with pytest.raises(NotFound) as raised:
        await fork(runtime)

    assert str(raised.value) == SESSION_NOT_FOUND
    assert await runtime.nothing_written()


@pytest.mark.parametrize("agent_id", [None, "assistant"], ids=["copy-pin", "switch-agent"])
async def test_a_fork_onto_an_id_another_app_holds_is_a_conflict_before_any_file_is_copied(
    agent_id: str | None,
) -> None:
    runtime = Runtime(sessions=RecordingSessions(target_taken=True))
    await runtime.seed_source({"video_shot.json": "{}"})

    with pytest.raises(Conflict) as raised:
        await fork(runtime, agent_id=agent_id)

    assert str(raised.value) == SESSION_ID_TAKEN
    assert await runtime.nothing_written()


@pytest.mark.parametrize(
    "apps",
    [{SOURCE: OTHER_APP, TARGET: APP}, {SOURCE: APP, TARGET: OTHER_APP}, {SOURCE: APP}],
    ids=["source-elsewhere", "target-elsewhere", "target-missing"],
)
async def test_copy_files_needs_both_sessions_to_be_the_callers_before_reading_anything(
    apps: dict[uuid.UUID, str],
) -> None:
    runtime = Runtime(sessions=RecordingSessions(apps=apps))
    await runtime.seed_source({"film.icml": "<film/>"})

    with pytest.raises(NotFound) as raised:
        await copy_files(runtime)

    assert str(raised.value) == SESSION_NOT_FOUND
    assert not await runtime.files.entries(TARGET_SPACE)
    assert not runtime.ledger.urls(TARGET_SPACE)
