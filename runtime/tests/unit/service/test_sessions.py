"""会话服务：分叉先挡掉分不了的、再固定版本、拷文件与素材、写种子快照；按清单拷文件缺了必需的就什么都不拷；
会话归开它的应用，别的应用的会话当作不存在、它的 id 也开不走。

会话表、队列与历史用替身，文件存储与素材台账用内存实现。不连库。"""

from __future__ import annotations

import uuid
from collections.abc import Collection
from dataclasses import dataclass, field
from datetime import UTC, datetime

import pytest

from agent_runtime.errors import Conflict, NotFound, ValidationFailed
from agent_runtime.file_store.namespace import namespace_for
from agent_runtime.file_store.store import FileEntry, StoredFile
from agent_runtime.harness.job_status import JobStatus
from agent_runtime.harness.jobs import JobQueueView, JobRow
from agent_runtime.material_ledger.store import Material
from agent_runtime.service.sessions import SESSION_ID_TAKEN, SESSION_NOT_FOUND, SessionService
from agent_runtime.transcript.ops import TextContent
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
PINNED = uuid.uuid4()
ASSISTANT_VERSION = uuid.uuid4()
REF = Material(url="https://example.test/ref.mp4", kind="video")


@dataclass
class RecordingSessions:
    """会话表替身：``apps`` 是已有会话归哪个应用（源与目标默认归 ``APP``），开与照抄按真实表的规矩认归属。"""

    apps: dict[uuid.UUID, str] = field(default_factory=lambda: {SOURCE: APP, TARGET: APP})
    opened: dict[uuid.UUID, uuid.UUID | None] = field(default_factory=dict)
    copied: list[tuple[uuid.UUID, uuid.UUID]] = field(default_factory=list)

    async def open(
        self, session_id: uuid.UUID, *, app_id: str, agent_version_id: uuid.UUID | None
    ) -> bool:
        if self.apps.setdefault(session_id, app_id) != app_id:
            return False
        self.opened[session_id] = agent_version_id
        return True

    async def copy(self, source_id: uuid.UUID, target_id: uuid.UUID, *, app_id: str) -> bool:
        if self.apps.setdefault(target_id, app_id) != app_id:
            return False
        self.copied.append((source_id, target_id))
        return True

    async def owned(
        self, session_ids: Collection[uuid.UUID], *, app_id: str
    ) -> frozenset[uuid.UUID]:
        return frozenset(one for one in session_ids if self.apps.get(one) == app_id)


async def current_version(agent_id: str) -> uuid.UUID:
    if agent_id != "assistant":
        raise ValidationFailed(f"没有标识为 {agent_id} 的 agent")
    return ASSISTANT_VERSION


def _row(status: JobStatus) -> JobRow:
    return JobRow(
        prompt_id=f"prm_{uuid.uuid4().hex[:16]}",
        conversation_id=str(SOURCE),
        agent_id="storyboard",
        owner_user_id=SOURCE_USER,
        user_name="logan",
        content=(TextContent(text="写三个镜头"),),
        status=status,
        run_id=None,
        created_at=datetime.now(UTC),
        finished_at=None,
        steered_at=None,
        locked_by=None,
        heartbeat_at=None,
        interrupt_reason=None,
        attempt=0,
        decisions={},
    )


@dataclass
class FixedQueue:
    view_of: JobQueueView = field(default_factory=lambda: JobQueueView(active=None, queued=()))

    async def view(self, conversation_id: str) -> JobQueueView:
        assert conversation_id == str(SOURCE)
        return self.view_of


@dataclass
class RecordingSeed:
    committed: list[str]
    target: str

    async def commit(self) -> None:
        self.committed.append(self.target)


@dataclass
class ScriptedHistory:
    """源有 ``turns`` 轮；``moved`` 时规划分叉报源变了（数完轮数之后又跑了一轮）。"""

    turns: int = 2
    moved: bool = False
    planned: list[tuple[str, int, str]] = field(default_factory=list)
    committed: list[str] = field(default_factory=list)

    async def turn_count(self, conversation_id: str) -> int:
        assert conversation_id == str(SOURCE)
        return self.turns

    async def plan_fork(
        self, conversation_id: str, *, ordinal: int, target_conversation_id: str
    ) -> RecordingSeed | None:
        self.planned.append((conversation_id, ordinal, target_conversation_id))
        if self.moved:
            return None
        return RecordingSeed(committed=self.committed, target=target_conversation_id)


class RecordingFileStore(FakeFileStore):
    """记下每一次写入经的是哪个入口、带没带版本。"""

    def __init__(self) -> None:
        super().__init__()
        self.writes: list[tuple[str, str, int | None]] = []

    async def write(
        self, namespace: str, path: str, content: str, *, expected_version: int | None = None
    ) -> FileEntry:
        self.writes.append((namespace, path, expected_version))
        return await super().write(namespace, path, content, expected_version=expected_version)


@dataclass
class Runtime:
    sessions: RecordingSessions = field(default_factory=RecordingSessions)
    queue: FixedQueue = field(default_factory=FixedQueue)
    history: ScriptedHistory = field(default_factory=ScriptedHistory)
    files: RecordingFileStore = field(default_factory=RecordingFileStore)
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
            # 源的版本号往前推一格：副本不该跟着搬。
            await self.files.write(SOURCE_SPACE, path, content)
        await self.ledger.record(SOURCE_SPACE, [REF])
        self.files.writes.clear()

    async def target_files(self) -> dict[str, StoredFile]:
        found: dict[str, StoredFile] = {}
        for entry in await self.files.entries(TARGET_SPACE):
            stored = await self.files.read(TARGET_SPACE, entry.path)
            assert stored is not None
            found[entry.path] = stored
        return found

    async def nothing_written(self) -> bool:
        return (
            not self.sessions.opened
            and not self.sessions.copied
            and not await self.files.entries(TARGET_SPACE)
            and not self.ledger.urls(TARGET_SPACE)
            and not self.history.committed
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


async def test_a_fork_copies_the_pin_the_workspace_and_the_ledger_then_seeds() -> None:
    runtime = Runtime()
    await runtime.seed_source({"video_shot.json": "{}", "notes/a.md": "笔记"})

    await fork(runtime, turn=2)

    assert runtime.sessions.copied == [(SOURCE, TARGET)]
    assert not runtime.sessions.opened
    copied = await runtime.target_files()
    assert {path: stored.content for path, stored in copied.items()} == {
        "notes/a.md": "笔记",
        "video_shot.json": "{}",
    }
    assert {stored.version for stored in copied.values()} == {1}, "源的版本号不跟着搬"
    assert runtime.ledger.urls(TARGET_SPACE) == {REF.url}
    assert runtime.history.planned == [(str(SOURCE), 2, str(TARGET))]
    assert runtime.history.committed == [str(TARGET)]


@pytest.mark.parametrize(
    "view",
    [
        JobQueueView(active=_row("running"), queued=()),
        JobQueueView(active=None, queued=(_row("queued"),)),
    ],
    ids=["running", "queued"],
)
async def test_a_busy_source_is_a_conflict_before_anything_is_written(view: JobQueueView) -> None:
    runtime = Runtime(queue=FixedQueue(view_of=view))
    await runtime.seed_source({"video_shot.json": "{}"})

    with pytest.raises(Conflict) as raised:
        await fork(runtime)

    assert str(raised.value) == "这段对话还有没跑完的消息，等它收完尾再分叉"
    assert await runtime.nothing_written()


@pytest.mark.parametrize(
    ("turns", "turn", "message"),
    [
        (0, 1, "这段对话还没跑过，没有可分叉的轮次"),
        (2, 3, "这段对话只有 2 轮，分不出第 3 轮"),
    ],
    ids=["never-ran", "beyond-the-end"],
)
async def test_a_turn_that_does_not_exist_is_refused_before_anything_is_written(
    turns: int, turn: int, message: str
) -> None:
    runtime = Runtime(history=ScriptedHistory(turns=turns))
    await runtime.seed_source({"video_shot.json": "{}"})

    with pytest.raises(ValidationFailed) as raised:
        await fork(runtime, turn=turn)

    assert str(raised.value) == message
    assert await runtime.nothing_written()


async def test_a_source_that_moved_before_the_seed_is_a_conflict_and_nothing_is_seeded() -> None:
    runtime = Runtime(history=ScriptedHistory(moved=True))
    await runtime.seed_source({"video_shot.json": "{}"})

    with pytest.raises(Conflict) as raised:
        await fork(runtime)

    assert str(raised.value) == "这段对话刚刚又跑了一轮，重新挑一个分叉点"
    assert runtime.history.planned == [(str(SOURCE), 1, str(TARGET))]
    assert not runtime.history.committed


async def test_switching_agents_pins_that_agents_current_version_instead_of_copying() -> None:
    runtime = Runtime()

    await fork(runtime, agent_id="assistant")

    assert runtime.sessions.opened == {TARGET: ASSISTANT_VERSION}
    assert not runtime.sessions.copied


async def test_an_agent_that_cannot_open_fails_the_fork_before_any_file_is_copied() -> None:
    runtime = Runtime()
    await runtime.seed_source({"video_shot.json": "{}"})

    with pytest.raises(ValidationFailed, match="没有标识为 gone 的 agent"):
        await fork(runtime, agent_id="gone")

    assert not await runtime.files.entries(TARGET_SPACE)
    assert not runtime.history.committed


async def test_open_pins_the_agents_current_version() -> None:
    runtime = Runtime()

    await runtime.service().open(TARGET, app_id=APP, agent_id="assistant")

    assert runtime.sessions.opened == {TARGET: ASSISTANT_VERSION}


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


async def test_copy_files_renames_what_the_source_has_skips_the_rest_and_brings_the_ledger() -> (
    None
):
    runtime = Runtime()
    await runtime.seed_source({"film.icml": "<film/>", "other.md": "不在清单里"})

    assert await copy_files(runtime)

    copied = await runtime.target_files()
    assert {path: stored.content for path, stored in copied.items()} == {"old_film.icml": "<film/>"}
    assert runtime.ledger.urls(TARGET_SPACE) == {REF.url}


async def test_copy_files_without_any_required_file_copies_nothing() -> None:
    runtime = Runtime()
    await runtime.seed_source({"treatment.md": "方案"})

    assert not await copy_files(runtime)

    assert not await runtime.files.entries(TARGET_SPACE)
    assert not runtime.ledger.urls(TARGET_SPACE)


async def test_copy_files_without_a_precondition_copies_what_the_source_has() -> None:
    runtime = Runtime()
    await runtime.seed_source({"treatment.md": "方案"})

    assert await copy_files(runtime, require_any=frozenset())

    copied = await runtime.target_files()
    assert {path: stored.content for path, stored in copied.items()} == {"treatment.md": "方案"}
    assert runtime.ledger.urls(TARGET_SPACE) == {REF.url}


async def test_copies_write_only_through_the_given_store_without_a_version_check() -> None:
    """拷贝只经注入的存储的写入口：容量与路径校验照旧，发不发文件变更帧看组合根给的是哪一层。"""

    runtime = Runtime()
    await runtime.seed_source({"film.icml": "<film/>", "treatment.md": "方案"})

    await copy_files(runtime)
    await runtime.service().fork(
        app_id=APP,
        source_id=SOURCE,
        source_user=SOURCE_USER,
        target_id=uuid.uuid4(),
        target_user=TARGET_USER,
        turn=1,
        agent_id=None,
    )

    assert runtime.files.writes, "拷贝要经存储的写入口"
    assert {expected for _, _, expected in runtime.files.writes} == {None}
    assert all(space.startswith(f"{TARGET_USER}/") for space, _, _ in runtime.files.writes)


class AlwaysBusyQueue:
    """一问就说源在忙：归属没认过就问到队列，别的应用会从 409 里看出这个会话存在。"""

    async def view(self, conversation_id: str) -> JobQueueView:
        return JobQueueView(active=_row("running"), queued=())


async def test_a_fork_from_another_apps_session_is_not_found_before_anything_else() -> None:
    runtime = Runtime(sessions=RecordingSessions(apps={SOURCE: OTHER_APP}))
    await runtime.seed_source({"video_shot.json": "{}"})
    service = SessionService(
        sessions=runtime.sessions,
        version_for_new_session=current_version,
        queue=AlwaysBusyQueue(),
        history=runtime.history,
        files=runtime.files,
        ledger=runtime.ledger,
    )

    with pytest.raises(NotFound) as raised:
        await service.fork(
            app_id=APP,
            source_id=SOURCE,
            source_user=SOURCE_USER,
            target_id=TARGET,
            target_user=TARGET_USER,
            turn=1,
            agent_id=None,
        )

    assert str(raised.value) == SESSION_NOT_FOUND
    assert await runtime.nothing_written()


async def test_a_fork_from_a_session_that_does_not_exist_is_the_same_not_found() -> None:
    runtime = Runtime(sessions=RecordingSessions(apps={}))

    with pytest.raises(NotFound) as raised:
        await fork(runtime)

    assert str(raised.value) == SESSION_NOT_FOUND
    assert await runtime.nothing_written()


@pytest.mark.parametrize("agent_id", [None, "assistant"], ids=["copy-pin", "switch-agent"])
async def test_a_fork_onto_an_id_another_app_holds_is_a_conflict_before_any_file_is_copied(
    agent_id: str | None,
) -> None:
    runtime = Runtime(sessions=RecordingSessions(apps={SOURCE: APP, TARGET: OTHER_APP}))
    await runtime.seed_source({"video_shot.json": "{}"})

    with pytest.raises(Conflict) as raised:
        await fork(runtime, agent_id=agent_id)

    assert str(raised.value) == SESSION_ID_TAKEN
    assert await runtime.nothing_written()


async def test_open_of_an_id_another_app_holds_is_a_conflict_and_keeps_its_owner() -> None:
    runtime = Runtime(sessions=RecordingSessions(apps={TARGET: OTHER_APP}))

    with pytest.raises(Conflict) as raised:
        await runtime.service().open(TARGET, app_id=APP, agent_id="assistant")

    assert str(raised.value) == SESSION_ID_TAKEN
    assert runtime.sessions.apps == {TARGET: OTHER_APP}
    assert not runtime.sessions.opened


async def test_open_gives_the_new_session_to_the_calling_app() -> None:
    runtime = Runtime(sessions=RecordingSessions(apps={}))

    await runtime.service().open(TARGET, app_id=APP, agent_id="assistant")

    assert runtime.sessions.apps == {TARGET: APP}
    assert await runtime.service().owned([TARGET], app_id=APP) == {TARGET}
    assert await runtime.service().owned([TARGET], app_id=OTHER_APP) == frozenset()


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
