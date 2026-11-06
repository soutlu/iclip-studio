from __future__ import annotations

import asyncio
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from typing import Any, Literal, NoReturn, cast

import pytest
from agent_runtime.errors import NotFound

from iclip.domains.conversations.models import Conversation, ConversationActivity, TitleKind
from iclip.domains.conversations.repository import (
    AgentPreviewStore,
    ConversationRepository,
    WholeFilmDraftStore,
)
from iclip.domains.conversations.service import (
    ActivitiesOf,
    ClaimTask,
    ConversationService,
    GenerateTitle,
    SameStyleFiles,
)
from iclip.domains.identity.public import Principal
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
class OneRowRepo:
    row: Conversation
    missing: bool = False

    def _write(self, **changes: Any) -> Conversation:
        if self.missing:
            raise NotFound("没有这段对话")
        self.row = replace(self.row, **changes)
        return self.row

    async def create_if_absent(self, conversation: Conversation) -> tuple[Conversation, bool]:
        if conversation.id == self.row.id:
            return self.row, False
        self.row = conversation
        return conversation, True

    async def get(
        self, conversation_id: uuid.UUID, *, owner: uuid.UUID | None, include_deleted: bool = False
    ) -> Conversation:
        if conversation_id != self.row.id:
            raise NotFound("没有这段对话")
        return self.row

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
        if self.row.title_kind != "default":
            return False
        self._write(title=title, title_kind="generated")
        return True


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


class ClaimDown(Exception):
    pass


@dataclass
class FlakyClaims:
    failures: int = 1
    owners: dict[uuid.UUID, uuid.UUID] = field(default_factory=dict)

    async def __call__(self, task_id: uuid.UUID, user_id: uuid.UUID) -> None:
        if self.failures > 0:
            self.failures -= 1
            raise ClaimDown("认领时连接被重置")
        self.owners[task_id] = user_id


def _untouched(*_: object, **__: object) -> NoReturn:
    raise AssertionError("这里用不到这个端口")


class OpensSessions:
    async def abort(self, session_id: uuid.UUID) -> None:
        raise AssertionError("这里不中断会话")

    async def open(self, session_id: uuid.UUID, *, agent_id: str) -> None:
        return None

    async def open_preview(
        self, session_id: uuid.UUID, *, agent_id: str, version_id: uuid.UUID | None
    ) -> None:
        _untouched()

    async def fork(
        self,
        *,
        source_id: uuid.UUID,
        source_user: uuid.UUID,
        target_id: uuid.UUID,
        target_user: uuid.UUID,
        turn: int,
        agent_id: str | None,
    ) -> None:
        _untouched()

    async def copy_files(
        self,
        *,
        source_id: uuid.UUID,
        source_user: uuid.UUID,
        target_id: uuid.UUID,
        target_user: uuid.UUID,
        files: Sequence[tuple[str, str]],
        require_any: frozenset[str],
    ) -> bool:
        _untouched()


async def _idle(ids: Sequence[uuid.UUID]) -> Mapping[uuid.UUID, ConversationActivity]:
    return {}


async def _exists(_: uuid.UUID) -> bool:
    return True


async def _until(ready: Callable[[], bool]) -> None:
    for _ in range(100):
        if ready():
            return
        await asyncio.sleep(0)
    raise AssertionError("等的那一步一直没到")


async def _settle() -> None:
    for _ in range(20):
        await asyncio.sleep(0)


def build(
    repo: object,
    announced: Announced,
    *,
    claim_task: ClaimTask = _untouched,
    activities_of: ActivitiesOf = _idle,
    generate_title: GenerateTitle = _untouched,
) -> ConversationService:
    return ConversationService(
        cast("ConversationRepository", repo),
        previews=cast("AgentPreviewStore", object()),
        runtime=OpensSessions(),
        list_collections=_untouched,
        claim_task=claim_task,
        task_exists=_exists,
        collection_exists=_exists,
        list_derived_files=_untouched,
        read_derived_file=_untouched,
        write_derived_file=_untouched,
        document_validators={},
        film=UnusedFilmPage(),
        drafts=cast("WholeFilmDraftStore", object()),
        draft_references=_untouched,
        exports=None,
        generate_title=generate_title,
        announce_title=announced.title,
        activities_of=activities_of,
        busy_conversation_ids=_untouched,
        latest_master_urls=_untouched,
        video_progress_of=_untouched,
        same_style_files=SameStyleFiles(files=(), require_any=frozenset()),
        same_style_source=_untouched,
        announce_row=announced.row,
        announce_deleted=announced.gone,
    )


async def test_marking_done_announces_the_written_row() -> None:
    existing = _row()
    announced = Announced()

    await build(OneRowRepo(row=existing), announced).set_completed(
        OWNER, existing.id, completed=True
    )

    [(kind, owner, conversation_id, row)] = announced.rows
    assert (kind, owner, conversation_id) == ("updated", OWNER.user_id, existing.id)
    assert row["completedAt"] is not None


async def test_a_replayed_create_claims_the_task_the_stored_row_hangs_on() -> None:
    announced = Announced()
    claims = FlakyClaims()
    service = build(OneRowRepo(row=_row()), announced, claim_task=claims)
    conversation_id, task_id = uuid.uuid4(), uuid.uuid4()

    with pytest.raises(ClaimDown):
        await service.create(
            OWNER, agent_id="storyboard", conversation_id=conversation_id, task_id=task_id
        )
    assert [(kind, sent_for) for kind, _, sent_for, _ in announced.rows] == [
        ("created", conversation_id)
    ]

    replayed, fresh = await service.create(
        OWNER, agent_id="storyboard", conversation_id=conversation_id
    )

    assert (replayed.id, replayed.task_id, fresh) == (conversation_id, task_id, False)
    assert claims.owners == {task_id: OWNER.user_id}
    assert len(announced.rows) == 1


async def test_attaching_a_task_announces_the_row_before_claiming_it() -> None:
    existing = _row()
    announced = Announced()
    claims = FlakyClaims()
    service = build(PlainRepo(row=existing), announced, claim_task=claims)
    task_id = uuid.uuid4()

    with pytest.raises(ClaimDown):
        await service.set_task(OWNER, existing.id, task_id=task_id)
    [(kind, _, _, row)] = announced.rows
    assert (kind, row["taskId"]) == ("updated", str(task_id))

    await service.set_task(OWNER, existing.id, task_id=task_id)

    assert claims.owners == {task_id: OWNER.user_id}


async def test_concurrent_writes_broadcast_their_rows_in_commit_order() -> None:
    existing = _row()
    repo = PlainRepo(row=existing)
    announced = Announced()
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

    service = build(repo, announced, activities_of=first_read_is_slow)
    first = asyncio.create_task(service.rename(OWNER, existing.id, title="old-write"))
    await _until(lambda: reads == 1)
    second = asyncio.create_task(service.rename(OWNER, existing.id, title="new-write"))
    await _settle()
    gate.set()
    await asyncio.gather(first, second)

    assert repo.committed == ["old-write", "new-write"]
    assert [row["title"] for _, _, _, row in announced.rows] == repo.committed
    assert [title for _, _, title in announced.titles] == repo.committed


async def test_generating_a_title_does_not_hold_up_a_rename() -> None:
    existing = _row()
    repo = PlainRepo(row=existing)
    announced = Announced()
    gate = asyncio.Event()

    async def slow_title(_: str) -> str | None:
        await gate.wait()
        return "模型起的名字"

    service = build(repo, announced, generate_title=slow_title)
    naming = asyncio.create_task(service.name_at_turn_start(existing.id, "做一条春季新款视频"))
    await _settle()
    assert not naming.done()

    await asyncio.wait_for(service.rename(OWNER, existing.id, title="用户起的名字"), timeout=1)
    gate.set()
    await naming

    assert repo.row.title == "用户起的名字"
    assert announced.titles == [(OWNER.user_id, existing.id, "用户起的名字")]


async def test_a_default_title_is_generated_and_announced() -> None:
    existing = _row()
    repo = PlainRepo(row=existing)
    announced = Announced()

    async def titled(_: str) -> str | None:
        return "春季新款视频"

    service = build(repo, announced, generate_title=titled)
    await service.name_at_turn_start(existing.id, "做一条春季新款视频")

    assert (repo.row.title, repo.row.title_kind) == ("春季新款视频", "generated")
    assert announced.titles == [(OWNER.user_id, existing.id, "春季新款视频")]


async def test_a_title_that_could_not_be_generated_stays_default_for_the_next_turn() -> None:
    existing = _row()
    repo = PlainRepo(row=existing)
    announced = Announced()

    async def nothing(_: str) -> str | None:
        return None

    service = build(repo, announced, generate_title=nothing)
    await service.name_at_turn_start(existing.id, "做一条春季新款视频")

    assert (repo.row.title, repo.row.title_kind) == ("一段对话", "default")
    assert announced.titles == []


@pytest.mark.parametrize("kind", ["custom", "generated"])
async def test_a_title_that_is_no_longer_default_is_not_generated_again(kind: TitleKind) -> None:
    existing = _row(title="已有的名字", title_kind=kind)
    repo = PlainRepo(row=existing)
    announced = Announced()

    service = build(repo, announced)
    await service.name_at_turn_start(existing.id, "做一条春季新款视频")

    assert (repo.row.title, repo.row.title_kind) == ("已有的名字", kind)
    assert announced.titles == []


async def test_clearing_the_completion_mark_from_another_domain_announces_the_row() -> None:
    existing = _row(completed_at=NOW)
    announced = Announced()

    await build(OneRowRepo(row=existing), announced).clear_completed(existing.id, OWNER.user_id)

    [(kind, _, _, row)] = announced.rows
    assert (kind, row["completedAt"]) == ("updated", None)


async def test_clearing_the_mark_on_an_invisible_conversation_announces_nothing() -> None:
    repo = OneRowRepo(row=_row(), missing=True)
    announced = Announced()

    await build(repo, announced).clear_completed(repo.row.id, OWNER.user_id)

    assert announced.rows == []


async def test_a_reported_run_start_on_a_missing_conversation_is_not_found() -> None:
    announced = Announced()

    with pytest.raises(NotFound):
        await build(OneRowRepo(row=_row()), announced).begin_reported_run(
            uuid.uuid4(), run_id="run-1", activity=ConversationActivity()
        )

    assert announced.rows == []
