"""对话行变化的广播：整行里的 ``lastSeq`` 必须取在写入之前（ADR-0004）。不连库。

客户端拿事件序号与行上的 ``lastSeq`` 合并 ``activity``：序号不大于水位的事件，行里已经有了；大于的，
以事件为准。水位要是取在写入之后，写入与取水位之间发生的事件会被当成「行里已经有了」，而行其实早于
它。帧自己的序号由广播方在提交后另发，见 ``test_live_connections``；同一段对话的整行帧按提交顺序取号。
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from typing import Any, Literal, NoReturn, cast

import pytest

from iclip.common.errors import NotFound
from iclip.domains.conversations.models import Conversation, ConversationActivity, TitleKind
from iclip.domains.conversations.repository import ConversationRepository
from iclip.domains.conversations.service import (
    ActivitiesOf,
    ClaimTask,
    ConversationService,
    ForkTranscript,
    GenerateTitle,
)
from iclip.domains.identity.public import Principal
from iclip.platform.transcript.session_events import SessionEventClock
from tests.helpers.film import UnusedFilmPage

NOW = datetime(2026, 10, 1, 12, 0, tzinfo=UTC)
OWNER = Principal(
    kind="user", user_id=uuid.uuid4(), permissions=frozenset({"agent:run"}), audit_label="logan"
)


def _row(**overrides: Any) -> Conversation:
    base = Conversation(
        id=uuid.uuid4(),
        owner_user_id=OWNER.user_id,
        agent_id="storyboard",
        title="一段对话",
        title_kind="default",
        last_run_id=None,
        task_id=None,
        collection_id=None,
        created_at=NOW,
        updated_at=NOW,
    )
    return replace(base, **overrides)


@dataclass
class RacingRepo:
    """写入途中另有一帧事件发号，模拟别的写入在本次写入与取水位之间提交。"""

    clock: SessionEventClock
    row: Conversation
    missing: bool = False

    def _write(self, **changes: Any) -> Conversation:
        if self.missing:
            raise NotFound("没有这段对话")
        self.clock.tick(self.row.id)
        self.row = replace(self.row, **changes)
        return self.row

    async def create_if_absent(self, conversation: Conversation) -> tuple[Conversation, bool]:
        if conversation.id == self.row.id:
            return self.row, False
        self.row = conversation
        return conversation, True

    async def rename(
        self, conversation_id: uuid.UUID, *, owner: uuid.UUID, title: str
    ) -> Conversation:
        return self._write(title=title, title_kind="custom")

    async def set_completed(
        self, conversation_id: uuid.UUID, *, owner: uuid.UUID, completed: bool
    ) -> Conversation:
        return self._write(completed_at=NOW if completed else None)

    async def touch_run(
        self, conversation_id: uuid.UUID, *, owner: uuid.UUID, agent_id: str, run_id: str
    ) -> Conversation:
        return self._write(last_run_id=run_id, completed_at=None)

    async def delete(self, conversation_id: uuid.UUID, *, owner: uuid.UUID) -> None:
        if self.missing:
            raise NotFound("没有这段对话")


@dataclass
class PlainRepo:
    """按调用先后提交、不另插事件的仓储；``committed`` 依次记下每次写入后的标题，即提交顺序。"""

    row: Conversation
    committed: list[str] = field(default_factory=list)

    def _write(self, **changes: Any) -> Conversation:
        self.row = replace(self.row, **changes)
        self.committed.append(self.row.title)
        return self.row

    async def get(
        self, conversation_id: uuid.UUID, *, owner: uuid.UUID | None, include_deleted: bool = False
    ) -> Conversation:
        return self.row

    async def rename(
        self, conversation_id: uuid.UUID, *, owner: uuid.UUID, title: str
    ) -> Conversation:
        return self._write(title=title, title_kind="custom")

    async def set_task(
        self, conversation_id: uuid.UUID, *, owner: uuid.UUID, task_id: uuid.UUID | None
    ) -> Conversation:
        return self._write(task_id=task_id)

    async def apply_generated_title(self, conversation_id: uuid.UUID, *, title: str) -> bool:
        # 与 SQL 的条件更新同一口径：只有还是默认标题时才写。
        if self.row.title_kind != "default":
            return False
        self._write(title=title, title_kind="generated")
        return True


@dataclass
class Announced:
    clock: SessionEventClock | None = None
    """给了就照 ``LiveConnections`` 在广播时取号：标题帧与整行帧都占号，按 (序号, 种类, 标题) 记进 ``frames``。"""
    rows: list[tuple[str, uuid.UUID, uuid.UUID, Mapping[str, Any]]] = field(default_factory=list)
    deleted: list[tuple[uuid.UUID, uuid.UUID]] = field(default_factory=list)
    titles: list[tuple[uuid.UUID, uuid.UUID, str]] = field(default_factory=list)
    frames: list[tuple[int, str, str]] = field(default_factory=list)

    def row(
        self,
        kind: Literal["created", "updated"],
        owner: uuid.UUID,
        conversation_id: uuid.UUID,
        row: Mapping[str, Any],
    ) -> None:
        self.rows.append((kind, owner, conversation_id, row))
        if self.clock is not None:
            self.frames.append((self.clock.tick(conversation_id), kind, row["title"]))

    def gone(self, owner: uuid.UUID, conversation_id: uuid.UUID) -> None:
        self.deleted.append((owner, conversation_id))

    def title(self, owner: uuid.UUID, conversation_id: uuid.UUID, title: str) -> None:
        self.titles.append((owner, conversation_id, title))
        if self.clock is not None:
            self.frames.append((self.clock.tick(conversation_id), "title", title))


class ClaimDown(Exception):
    """认领那一步的连接被重置。"""


@dataclass
class FlakyClaims:
    """前 ``failures`` 次认领抛 ``ClaimDown``，之后照常；每次调用都记下参数。"""

    failures: int = 1
    calls: list[tuple[uuid.UUID, uuid.UUID]] = field(default_factory=list)

    async def __call__(self, task_id: uuid.UUID, user_id: uuid.UUID) -> None:
        self.calls.append((task_id, user_id))
        if self.failures > 0:
            self.failures -= 1
            raise ClaimDown("认领时连接被重置")


def _untouched(*_: object, **__: object) -> NoReturn:
    raise AssertionError("这里用不到这个端口")


async def _idle(ids: Sequence[uuid.UUID]) -> Mapping[uuid.UUID, ConversationActivity]:
    return {}


async def _until(ready: Callable[[], bool]) -> None:
    """让出事件循环，直到别的任务走到 ``ready`` 成立的那一步。"""

    for _ in range(100):
        if ready():
            return
        await asyncio.sleep(0)
    raise AssertionError("等的那一步一直没到")


async def _settle() -> None:
    """多让几拍，让已经开工的任务走到它此刻能走到的最远处。"""

    for _ in range(20):
        await asyncio.sleep(0)


def build(
    repo: object,
    clock: SessionEventClock,
    announced: Announced,
    *,
    claim_task: ClaimTask = _untouched,
    activities_of: ActivitiesOf = _idle,
    generate_title: GenerateTitle = _untouched,
) -> ConversationService:
    return ConversationService(
        cast("ConversationRepository", repo),
        list_collections=_untouched,
        claim_task=claim_task,
        list_derived_files=_untouched,
        read_derived_file=_untouched,
        write_derived_file=_untouched,
        document_validators={},
        film=UnusedFilmPage(),
        generate_title=generate_title,
        announce_title=announced.title,
        activities_of=activities_of,
        busy_conversation_ids=_untouched,
        latest_master_urls=_untouched,
        fork_transcript=cast("ForkTranscript", object()),
        copy_workspace=_untouched,
        copy_same_style=_untouched,
        event_watermark=clock.snapshot,
        announce_row=announced.row,
        announce_deleted=announced.gone,
    )


async def test_an_updated_row_carries_the_watermark_taken_before_the_write() -> None:
    clock = SessionEventClock()
    existing = _row()
    clock.tick(existing.id)
    repo = RacingRepo(clock=clock, row=existing)
    announced = Announced()

    await build(repo, clock, announced).set_completed(OWNER, existing.id, completed=True)

    [(kind, owner, conversation_id, row)] = announced.rows
    assert (kind, owner, conversation_id) == ("updated", OWNER.user_id, existing.id)
    # 写入途中那一帧拿到 2：它比这一行新，行上的水位必须停在写入之前的 1。
    assert clock.current(existing.id) == 2
    assert row["lastSeq"] == 1
    assert row["eventEpoch"] == clock.epoch
    assert row["completedAt"] is not None


async def test_a_rename_announces_the_title_event_and_the_row() -> None:
    clock = SessionEventClock()
    existing = _row()
    repo = RacingRepo(clock=clock, row=existing)
    announced = Announced()

    await build(repo, clock, announced).rename(OWNER, existing.id, title="新名字")

    assert announced.titles == [(OWNER.user_id, existing.id, "新名字")]
    [(kind, _, _, row)] = announced.rows
    assert (kind, row["title"], row["lastSeq"]) == ("updated", "新名字", 0)


async def test_a_new_conversation_is_announced_but_an_idempotent_replay_is_not() -> None:
    clock = SessionEventClock()
    existing = _row()
    repo = RacingRepo(clock=clock, row=existing)
    announced = Announced()
    service = build(repo, clock, announced)

    await service.create(OWNER, agent_id="storyboard", conversation_id=existing.id)
    assert announced.rows == []

    created, fresh = await service.create(OWNER, agent_id="storyboard")
    assert fresh is True
    [(kind, owner, conversation_id, row)] = announced.rows
    assert (kind, owner, conversation_id, row["id"]) == (
        "created",
        OWNER.user_id,
        created.id,
        str(created.id),
    )


async def test_a_replayed_create_claims_the_task_the_stored_row_hangs_on() -> None:
    """首次死在对话行提交之后、认领之前：created 帧照样发出；同一个 id 重发补上认领，不再补发帧。"""

    clock = SessionEventClock()
    repo = RacingRepo(clock=clock, row=_row())
    announced = Announced()
    claims = FlakyClaims()
    service = build(repo, clock, announced, claim_task=claims)
    conversation_id, task_id = uuid.uuid4(), uuid.uuid4()

    with pytest.raises(ClaimDown):
        await service.create(
            OWNER, agent_id="storyboard", conversation_id=conversation_id, task_id=task_id
        )
    assert [(kind, sent_for) for kind, _, sent_for, _ in announced.rows] == [
        ("created", conversation_id)
    ]

    # 重发的请求体不带需求单：认领看的是落库的那一行，不是这一次的请求。
    replayed, fresh = await service.create(
        OWNER, agent_id="storyboard", conversation_id=conversation_id
    )

    assert (replayed.id, replayed.task_id, fresh) == (conversation_id, task_id, False)
    assert claims.calls == [(task_id, OWNER.user_id), (task_id, OWNER.user_id)]
    assert len(announced.rows) == 1


async def test_attaching_a_task_announces_the_row_before_claiming_it() -> None:
    """认领是别的模块的端口：它失败时行已经提交，updated 帧不能跟着丢；重新挂同一张单补上认领。"""

    clock = SessionEventClock()
    existing = _row()
    announced = Announced()
    claims = FlakyClaims()
    service = build(PlainRepo(row=existing), clock, announced, claim_task=claims)
    task_id = uuid.uuid4()

    with pytest.raises(ClaimDown):
        await service.set_task(OWNER, existing.id, task_id=task_id)
    [(kind, _, _, row)] = announced.rows
    assert (kind, row["taskId"]) == ("updated", str(task_id))

    await service.set_task(OWNER, existing.id, task_id=task_id)

    assert claims.calls == [(task_id, OWNER.user_id), (task_id, OWNER.user_id)]


async def test_concurrent_writes_take_frame_numbers_in_commit_order() -> None:
    """两次改名在读活动处交错：先提交那次的活动读得慢，它的整行帧也不能比后提交那次晚取号。

    不串行时帧是 seq 3 = new-write、seq 4 = old-write，客户端按「序号大者为准」把标题改回旧的，
    库里却是新的（ADR-0004）。"""

    clock = SessionEventClock()
    existing = _row()
    repo = PlainRepo(row=existing)
    announced = Announced(clock=clock)
    gate = asyncio.Event()
    reads = 0

    async def first_read_is_slow(
        ids: Sequence[uuid.UUID],
    ) -> Mapping[uuid.UUID, ConversationActivity]:
        nonlocal reads
        reads += 1
        if reads == 1:
            await gate.wait()
        return {}

    service = build(repo, clock, announced, activities_of=first_read_is_slow)
    first = asyncio.create_task(service.rename(OWNER, existing.id, title="old-write"))
    await _until(lambda: reads == 1)
    second = asyncio.create_task(service.rename(OWNER, existing.id, title="new-write"))
    await _settle()
    gate.set()
    await asyncio.gather(first, second)

    assert repo.committed == ["old-write", "new-write"]
    rows = sorted((seq, title) for seq, kind, title in announced.frames if kind == "updated")
    assert [title for _, title in rows] == repo.committed


async def test_generating_a_title_does_not_hold_up_a_rename() -> None:
    """生成标题要调模型，不能占着这段对话的行锁：模型还没回话时，属主的改名照常落地。"""

    clock = SessionEventClock()
    existing = _row()
    repo = PlainRepo(row=existing)
    announced = Announced()
    gate = asyncio.Event()

    async def slow_title(_: str) -> str | None:
        await gate.wait()
        return "模型起的名字"

    service = build(repo, clock, announced, generate_title=slow_title)
    naming = asyncio.create_task(service.name_at_turn_start(existing.id, "做一条春季新款视频"))
    await _settle()
    assert not naming.done()

    await asyncio.wait_for(service.rename(OWNER, existing.id, title="用户起的名字"), timeout=1)
    gate.set()
    await naming

    # 属主改过名，条件更新不再覆盖，也就不发标题帧。
    assert repo.row.title == "用户起的名字"
    assert announced.titles == [(OWNER.user_id, existing.id, "用户起的名字")]


async def test_a_default_title_is_generated_and_announced() -> None:
    clock = SessionEventClock()
    existing = _row()
    repo = PlainRepo(row=existing)
    announced = Announced()

    async def titled(_: str) -> str | None:
        return "春季新款视频"

    service = build(repo, clock, announced, generate_title=titled)
    await service.name_at_turn_start(existing.id, "做一条春季新款视频")

    assert (repo.row.title, repo.row.title_kind) == ("春季新款视频", "generated")
    assert announced.titles == [(OWNER.user_id, existing.id, "春季新款视频")]


async def test_a_title_that_could_not_be_generated_stays_default_for_the_next_turn() -> None:
    clock = SessionEventClock()
    existing = _row()
    repo = PlainRepo(row=existing)
    announced = Announced()

    async def nothing(_: str) -> str | None:
        return None

    service = build(repo, clock, announced, generate_title=nothing)
    await service.name_at_turn_start(existing.id, "做一条春季新款视频")

    assert (repo.row.title, repo.row.title_kind) == ("一段对话", "default")
    assert announced.titles == []


@pytest.mark.parametrize("kind", ["custom", "generated"])
async def test_a_title_that_is_no_longer_default_is_not_generated_again(kind: TitleKind) -> None:
    """改过名或已经起过名的对话，开新一轮时不再调模型。"""

    clock = SessionEventClock()
    existing = _row(title="已有的名字", title_kind=kind)
    repo = PlainRepo(row=existing)
    announced = Announced()

    # 生成端口是 _untouched：一旦调模型就抛错。
    service = build(repo, clock, announced)
    await service.name_at_turn_start(existing.id, "做一条春季新款视频")

    assert (repo.row.title, repo.row.title_kind) == ("已有的名字", kind)
    assert announced.titles == []


async def test_clearing_the_completion_mark_from_another_domain_announces_the_row() -> None:
    """出片提交抹掉收尾标记，与属主手动取消是同一种行变化。"""

    clock = SessionEventClock()
    existing = _row(completed_at=NOW)
    repo = RacingRepo(clock=clock, row=existing)
    announced = Announced()

    await build(repo, clock, announced).clear_completed(existing.id, OWNER.user_id)

    [(kind, _, _, row)] = announced.rows
    assert (kind, row["completedAt"]) == ("updated", None)


async def test_clearing_the_mark_on_an_invisible_conversation_announces_nothing() -> None:
    clock = SessionEventClock()
    repo = RacingRepo(clock=clock, row=_row(), missing=True)
    announced = Announced()

    await build(repo, clock, announced).clear_completed(repo.row.id, OWNER.user_id)

    assert announced.rows == []


async def test_a_delete_is_announced_after_it_lands() -> None:
    clock = SessionEventClock()
    existing = _row()
    announced = Announced()

    await build(RacingRepo(clock=clock, row=existing), clock, announced).delete(OWNER, existing.id)

    assert announced.deleted == [(OWNER.user_id, existing.id)]


async def test_starting_a_run_announces_the_new_run_and_the_cleared_mark() -> None:
    """开跑记录运行发 ``updated``（ADR-0005）：帧带新的 lastRunId、收尾标记为空，行内水位停在写入之前。

    写入途中另有一帧发号（开跑的活动帧），行内 ``lastSeq`` 小于它；广播方随后给这一帧另发的号更大。"""

    clock = SessionEventClock()
    existing = _row(completed_at=NOW, last_run_id="run-0")
    clock.tick(existing.id)
    repo = RacingRepo(clock=clock, row=existing)
    announced = Announced()

    await build(repo, clock, announced).begin_run(
        owner=OWNER.user_id, agent_id="storyboard", conversation_id=str(existing.id), run_id="run-1"
    )

    [(kind, owner, conversation_id, row)] = announced.rows
    assert (kind, owner, conversation_id) == ("updated", OWNER.user_id, existing.id)
    assert row["lastRunId"] == "run-1"
    assert row["completedAt"] is None
    assert row["lastSeq"] == 1
    assert clock.current(existing.id) == 2
