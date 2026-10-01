"""对话行变化的广播：整行里的 ``lastSeq`` 必须取在写入之前（ADR-0004）。不连库。

客户端拿事件序号与行上的 ``lastSeq`` 合并 ``activity``：序号不大于水位的事件，行里已经有了；大于的，
以事件为准。水位要是取在写入之后，写入与取水位之间发生的事件会被当成「行里已经有了」，而行其实早于
它。帧自己的序号由广播方在提交后另发，见 ``test_live_connections``。
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from typing import Any, Literal, NoReturn, cast

from iclip.common.errors import NotFound
from iclip.domains.conversations.models import Conversation, ConversationActivity
from iclip.domains.conversations.repository import ConversationRepository
from iclip.domains.conversations.service import ConversationService, ForkTranscript
from iclip.domains.identity.public import Principal
from iclip.platform.transcript.session_events import SessionEventClock

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
class Announced:
    rows: list[tuple[str, uuid.UUID, uuid.UUID, Mapping[str, Any]]] = field(default_factory=list)
    deleted: list[tuple[uuid.UUID, uuid.UUID]] = field(default_factory=list)
    titles: list[tuple[uuid.UUID, uuid.UUID, str]] = field(default_factory=list)

    def row(
        self,
        kind: Literal["created", "updated"],
        owner: uuid.UUID,
        conversation_id: uuid.UUID,
        row: Mapping[str, Any],
    ) -> None:
        self.rows.append((kind, owner, conversation_id, row))

    def gone(self, owner: uuid.UUID, conversation_id: uuid.UUID) -> None:
        self.deleted.append((owner, conversation_id))

    def title(self, owner: uuid.UUID, conversation_id: uuid.UUID, title: str) -> None:
        self.titles.append((owner, conversation_id, title))


def _untouched(*_: object, **__: object) -> NoReturn:
    raise AssertionError("这里用不到这个端口")


async def _idle(ids: Sequence[uuid.UUID]) -> Mapping[uuid.UUID, ConversationActivity]:
    return {}


def build(repo: RacingRepo, clock: SessionEventClock, announced: Announced) -> ConversationService:
    return ConversationService(
        cast("ConversationRepository", repo),
        list_collections=_untouched,
        claim_task=_untouched,
        list_derived_files=_untouched,
        read_derived_file=_untouched,
        write_derived_file=_untouched,
        document_validators={},
        generate_title=_untouched,
        announce_title=announced.title,
        activities_of=_idle,
        busy_conversation_ids=_untouched,
        latest_master_urls=_untouched,
        fork_transcript=cast("ForkTranscript", object()),
        copy_workspace=_untouched,
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
