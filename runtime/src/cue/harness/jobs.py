from __future__ import annotations

import json
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Final, NamedTuple, cast

from pydantic import TypeAdapter
from sqlalchemy import (
    Column,
    ColumnElement,
    Executable,
    Index,
    Integer,
    MetaData,
    PrimaryKeyConstraint,
    Table,
    Text,
    and_,
    case,
    exists,
    func,
    insert,
    null,
    or_,
    select,
    update,
)
from sqlalchemy.dialects.postgresql import TIMESTAMP, UUID
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine

from cue.errors import Conflict, NotFound
from cue.harness.job_status import JobStatus
from cue.harness.transcript.activity import ActivityState, activity_of
from cue.harness.transcript.from_messages import SteeredPrompt
from cue.transcript.ops import Prompt, PromptContent

DB_SCHEMA: Final = "agent_runtime"

_ACTIVE: Final = ("running", "awaiting")

_LIVE: Final = ("running", "awaiting", "queued")

STEERED_ABORT_CONFLICT: Final = "这条消息已经递进当前这一轮了，要停就停整段对话"

metadata_obj = MetaData(schema=DB_SCHEMA)

agent_jobs_table = Table(
    "agent_jobs",
    metadata_obj,
    Column("prompt_id", Text, nullable=False),
    Column("conversation_id", Text, nullable=False),
    Column("agent_id", Text, nullable=False),
    Column("owner_user_id", UUID(as_uuid=True), nullable=False),
    Column("user_name", Text, nullable=False),
    Column("content", Text, nullable=False),
    Column("status", Text, nullable=False),
    Column("run_id", Text),
    Column("created_at", TIMESTAMP(timezone=True), nullable=False),
    Column("finished_at", TIMESTAMP(timezone=True)),
    Column("steered_at", TIMESTAMP(timezone=True)),
    Column("locked_by", Text),
    Column("heartbeat_at", TIMESTAMP(timezone=True)),
    Column("interrupt_reason", Text),
    Column("attempt", Integer, nullable=False, server_default="0"),
    Column("decisions", Text),
    PrimaryKeyConstraint("prompt_id"),
    Index(
        "uq_agent_jobs_one_running_per_conversation",
        "conversation_id",
        unique=True,
        postgresql_where=Column("status").in_(_ACTIVE),
    ),
    Index("idx_agent_jobs_queue", "conversation_id", "created_at"),
    Index("idx_agent_jobs_created", "created_at"),
    Index(
        "idx_agent_jobs_lease",
        "heartbeat_at",
        postgresql_where=Column("status") == "running",
    ),
)

agent_job_runs_table = Table(
    "agent_job_runs",
    metadata_obj,
    Column("run_id", Text, nullable=False),
    Column("prompt_id", Text, nullable=False),
    Column("started_at", TIMESTAMP(timezone=True), nullable=False),
    PrimaryKeyConstraint("run_id"),
    Index("idx_agent_job_runs_prompt", "prompt_id"),
)


@dataclass(frozen=True, slots=True)
class JobRow:
    prompt_id: str
    conversation_id: str
    agent_id: str
    owner_user_id: uuid.UUID
    user_name: str
    content: tuple[PromptContent, ...]
    status: JobStatus
    run_id: str | None
    created_at: datetime
    finished_at: datetime | None
    steered_at: datetime | None
    locked_by: str | None
    heartbeat_at: datetime | None
    interrupt_reason: str | None
    attempt: int
    decisions: Mapping[str, bool]

    @property
    def text(self) -> str:
        return "\n".join(part.text for part in self.content if part.type == "text")

    def as_entity(self) -> Prompt:
        return Prompt(
            prompt_id=self.prompt_id,
            status="running" if self.status in ("steered", "awaiting") else self.status,
            content=self.content,
            created_at=self.created_at.isoformat(),
            finished_at=None if self.finished_at is None else self.finished_at.isoformat(),
            steered_at=None if self.steered_at is None else self.steered_at.isoformat(),
        )


@dataclass(frozen=True, slots=True)
class JobQueueView:
    active: JobRow | None
    queued: tuple[JobRow, ...]


class Submission(NamedTuple):
    row: JobRow
    accepted: bool


ActivityChanged = Callable[[str, uuid.UUID, ActivityState], None]


class JobQueue:
    def __init__(self, engine: AsyncEngine, *, on_activity: ActivityChanged | None = None) -> None:
        self._engine = engine
        self._on_activity = on_activity

    def _changed(self, row: JobRow, status: JobStatus) -> None:
        if self._on_activity is not None:
            self._on_activity(row.conversation_id, row.owner_user_id, activity_of(status))

    async def submit(
        self,
        *,
        prompt_id: str,
        conversation_id: str,
        agent_id: str,
        owner_user_id: uuid.UUID,
        user_name: str,
        content: tuple[PromptContent, ...],
        now: datetime,
        locked_by: str,
    ) -> Submission:
        existing = await self.get(prompt_id)
        if existing is not None:
            if existing.conversation_id != conversation_id:
                raise Conflict("这个消息 id 已经用过了，换一个")
            return Submission(existing, accepted=False)
        busy = exists(
            select(agent_jobs_table.c.prompt_id)
            .where(agent_jobs_table.c.conversation_id == conversation_id)
            .where(agent_jobs_table.c.status.in_(_ACTIVE))
        )
        values = {
            "prompt_id": prompt_id,
            "conversation_id": conversation_id,
            "agent_id": agent_id,
            "owner_user_id": owner_user_id,
            "user_name": user_name,
            "content": _dump(content),
            "created_at": now,
        }
        stmt = (
            insert(agent_jobs_table)
            .values(
                **values,
                status=case((busy, "queued"), else_="running"),
                locked_by=case((busy, null()), else_=locked_by),
                heartbeat_at=case((busy, null()), else_=func.now()),
            )
            .returning(agent_jobs_table)
        )
        try:
            row = await self._one(stmt)
        except IntegrityError:
            try:
                row = await self._one(
                    insert(agent_jobs_table)
                    .values(**values, status="queued")
                    .returning(agent_jobs_table)
                )
            except IntegrityError as exc:
                existing = await self.get(prompt_id)
                if existing is None:
                    raise
                if existing.conversation_id != conversation_id:
                    raise Conflict("这个消息 id 已经用过了，换一个") from exc
                return Submission(existing, accepted=False)
        if row is None:
            raise Conflict("这条消息没被收下")
        if row.status == "running":
            self._changed(row, row.status)
        return Submission(row, accepted=True)

    async def view(self, conversation_id: str) -> JobQueueView:
        stmt = (
            select(agent_jobs_table)
            .where(agent_jobs_table.c.conversation_id == conversation_id)
            .where(agent_jobs_table.c.status.in_(_LIVE))
            .order_by(agent_jobs_table.c.created_at.asc(), agent_jobs_table.c.prompt_id.asc())
        )
        rows = await self._rows(stmt)
        active = next((row for row in rows if row.status in _ACTIVE), None)
        return JobQueueView(
            active=active, queued=tuple(row for row in rows if row.status == "queued")
        )

    async def get(self, prompt_id: str) -> JobRow | None:
        found = await self._rows(
            select(agent_jobs_table).where(agent_jobs_table.c.prompt_id == prompt_id)
        )
        return found[0] if found else None

    async def get_by_run(self, run_id: str, *, conversation_id: str) -> JobRow | None:
        stmt = (
            select(agent_jobs_table)
            .join(
                agent_job_runs_table,
                agent_job_runs_table.c.prompt_id == agent_jobs_table.c.prompt_id,
            )
            .where(agent_job_runs_table.c.run_id == run_id)
            .where(agent_jobs_table.c.conversation_id == conversation_id)
        )
        found = await self._rows(stmt)
        return found[0] if found else None

    async def prompt_of_runs(self, conversation_id: str) -> dict[str, str]:
        stmt = (
            select(agent_job_runs_table.c.run_id, agent_job_runs_table.c.prompt_id)
            .join(
                agent_jobs_table, agent_jobs_table.c.prompt_id == agent_job_runs_table.c.prompt_id
            )
            .where(agent_jobs_table.c.conversation_id == conversation_id)
        )
        async with self._engine.connect() as conn:
            return {run_id: prompt_id for run_id, prompt_id in (await conn.execute(stmt)).all()}

    async def prompt_status_of_runs(self, conversation_id: str) -> dict[str, JobStatus]:
        stmt = (
            select(agent_job_runs_table.c.run_id, agent_jobs_table.c.status)
            .join(
                agent_jobs_table, agent_jobs_table.c.prompt_id == agent_job_runs_table.c.prompt_id
            )
            .where(agent_jobs_table.c.conversation_id == conversation_id)
        )
        async with self._engine.connect() as conn:
            return {
                run_id: cast("JobStatus", status)
                for run_id, status in (await conn.execute(stmt)).all()
            }

    async def steered_prompts(self, conversation_id: str) -> tuple[SteeredPrompt, ...]:
        stmt = (
            select(agent_jobs_table)
            .where(agent_jobs_table.c.conversation_id == conversation_id)
            .where(agent_jobs_table.c.steered_at.is_not(None))
            .order_by(agent_jobs_table.c.steered_at.asc(), agent_jobs_table.c.prompt_id.asc())
        )
        return tuple(
            SteeredPrompt(prompt_id=row.prompt_id, run_id=row.run_id, content=row.content)
            for row in await self._rows(stmt)
        )

    async def activities(self, conversation_ids: Sequence[str]) -> dict[str, ActivityState]:
        if not conversation_ids:
            return {}
        decisive = await self._decisive(
            agent_jobs_table.c.conversation_id.in_(tuple(conversation_ids))
        )
        return {one: activity_of(decisive.get(one)) for one in conversation_ids}

    async def busy_conversation_ids(self, owner_user_id: uuid.UUID | None) -> frozenset[str]:
        stmt = (
            select(agent_jobs_table.c.conversation_id)
            .distinct()
            .where(agent_jobs_table.c.status.in_(_ACTIVE))
        )
        if owner_user_id is not None:
            stmt = stmt.where(agent_jobs_table.c.owner_user_id == owner_user_id)
        async with self._engine.connect() as conn:
            return frozenset((await conn.execute(stmt)).scalars().all())

    async def _decisive(self, scope: ColumnElement[bool]) -> dict[str, JobStatus]:
        stmt = (
            select(agent_jobs_table.c.conversation_id, agent_jobs_table.c.status)
            .where(scope)
            .where(agent_jobs_table.c.status.not_in(("queued", "steered")))
            .where(
                ~and_(agent_jobs_table.c.status == "aborted", agent_jobs_table.c.run_id.is_(None))
            )
            .distinct(agent_jobs_table.c.conversation_id)
            .order_by(
                agent_jobs_table.c.conversation_id,
                agent_jobs_table.c.status.in_(_ACTIVE).desc(),
                agent_jobs_table.c.finished_at.desc().nulls_last(),
                agent_jobs_table.c.created_at.desc(),
            )
        )
        async with self._engine.connect() as conn:
            return {
                conversation_id: cast("JobStatus", status)
                for conversation_id, status in (await conn.execute(stmt)).all()
            }

    async def start_next(self, conversation_id: str, *, locked_by: str) -> JobRow | None:
        head = (
            select(agent_jobs_table.c.prompt_id)
            .where(agent_jobs_table.c.conversation_id == conversation_id)
            .where(agent_jobs_table.c.status == "queued")
            .order_by(agent_jobs_table.c.created_at.asc(), agent_jobs_table.c.prompt_id.asc())
            .limit(1)
            .scalar_subquery()
        )
        running = (
            select(agent_jobs_table.c.prompt_id)
            .where(agent_jobs_table.c.conversation_id == conversation_id)
            .where(agent_jobs_table.c.status.in_(_ACTIVE))
        )
        stmt = (
            update(agent_jobs_table)
            .where(agent_jobs_table.c.prompt_id == head)
            .where(~exists(running))
            .values(status="running", locked_by=locked_by, heartbeat_at=func.now())
            .returning(agent_jobs_table)
        )
        try:
            row = await self._one(stmt)
        except IntegrityError:
            return None
        if row is not None:
            self._changed(row, row.status)
        return row

    async def attach_run(
        self, prompt_id: str, run_id: str, *, locked_by: str, attempt: int
    ) -> bool:
        claim = (
            update(agent_jobs_table)
            .where(_owned(prompt_id, locked_by, attempt))
            .values(run_id=run_id)
        )
        async with self._engine.begin() as conn:
            if (await conn.execute(claim)).rowcount != 1:
                return False
            await conn.execute(
                insert(agent_job_runs_table).values(
                    run_id=run_id, prompt_id=prompt_id, started_at=func.now()
                )
            )
        return True

    async def finish(
        self,
        prompt_id: str,
        *,
        status: JobStatus,
        now: datetime,
        locked_by: str,
        attempt: int,
        reason: str | None = None,
    ) -> None:
        values: dict[str, object] = {"status": status, "finished_at": now}
        if reason is not None:
            values["interrupt_reason"] = reason
        stmt = (
            update(agent_jobs_table)
            .where(_owned(prompt_id, locked_by, attempt))
            .where(agent_jobs_table.c.status.in_(_LIVE))
            .values(values)
            .returning(agent_jobs_table)
        )
        row = await self._one(stmt)
        if row is not None:
            self._changed(row, status)

    async def abort(self, prompt_id: str, *, conversation_id: str, now: datetime) -> JobRow:
        stmt = (
            update(agent_jobs_table)
            .where(agent_jobs_table.c.prompt_id == prompt_id)
            .where(agent_jobs_table.c.conversation_id == conversation_id)
            .where(agent_jobs_table.c.status.in_(("queued", "awaiting")))
            .values(status="aborted", finished_at=now)
            .returning(agent_jobs_table)
        )
        aborted = await self._one(stmt)
        if aborted is not None:
            if aborted.run_id is not None:
                self._changed(aborted, "aborted")
            return aborted
        row = await self.get(prompt_id)
        if row is None or row.conversation_id != conversation_id:
            raise NotFound(f"没有这条消息：{prompt_id}")
        if row.status == "steered":
            raise Conflict(STEERED_ABORT_CONFLICT)
        if row.status != "running":
            raise Conflict("这条消息已经结束了，停不了")
        return row

    async def abort_queued(
        self, conversation_id: str, *, now: datetime, only: tuple[str, ...] | None = None
    ) -> tuple[JobRow, ...]:
        stmt = (
            update(agent_jobs_table)
            .where(agent_jobs_table.c.conversation_id == conversation_id)
            .where(agent_jobs_table.c.status == "queued")
            .values(status="aborted", finished_at=now)
            .returning(agent_jobs_table)
        )
        if only is not None:
            stmt = stmt.where(agent_jobs_table.c.prompt_id.in_(only))
        return await self._all(stmt)

    async def pick_for_steer(
        self, conversation_id: str, prompt_ids: tuple[str, ...]
    ) -> tuple[JobRow, ...]:
        view = await self.view(conversation_id)
        if view.active is None:
            raise Conflict("这段对话现在没有在跑的运行，插不进去")
        queued = {row.prompt_id: row for row in view.queued}
        picked = []
        for prompt_id in prompt_ids:
            row = queued.get(prompt_id)
            if row is None:
                raise NotFound(f"这条消息不在这段对话的队列里：{prompt_id}")
            picked.append(row)
        return tuple(picked)

    async def mark_steered(
        self, prompt_ids: tuple[str, ...], *, run_id: str, now: datetime
    ) -> tuple[JobRow, ...]:
        stmt = (
            update(agent_jobs_table)
            .where(agent_jobs_table.c.prompt_id.in_(prompt_ids))
            .where(agent_jobs_table.c.status == "queued")
            .values(status="steered", run_id=run_id, steered_at=now)
            .returning(agent_jobs_table)
        )
        return await self._all(stmt)

    async def settle_steered(
        self, run_id: str, *, status: JobStatus, now: datetime
    ) -> tuple[JobRow, ...]:
        stmt = (
            update(agent_jobs_table)
            .where(agent_jobs_table.c.run_id == run_id)
            .where(agent_jobs_table.c.status == "steered")
            .values(status=status, finished_at=now)
            .returning(agent_jobs_table)
        )
        return await self._all(stmt)

    async def heartbeat(self, *, locked_by: str) -> tuple[str, ...]:
        stmt = (
            update(agent_jobs_table)
            .where(agent_jobs_table.c.locked_by == locked_by)
            .where(agent_jobs_table.c.status == "running")
            .values(heartbeat_at=func.now())
            .returning(agent_jobs_table.c.prompt_id)
        )
        async with self._engine.begin() as conn:
            return tuple((await conn.execute(stmt)).scalars().all())

    async def release(self, prompt_id: str, *, locked_by: str, reason: str, attempt: int) -> None:
        stmt = (
            update(agent_jobs_table)
            .where(_owned(prompt_id, locked_by, attempt))
            .where(agent_jobs_table.c.status == "running")
            .values(locked_by=None, heartbeat_at=None, interrupt_reason=reason)
        )
        await self._one(stmt.returning(agent_jobs_table))

    async def claim_interrupted(
        self, *, locked_by: str, lease_seconds: int, max_attempts: int
    ) -> tuple[JobRow, ...]:
        stmt = (
            update(agent_jobs_table)
            .where(_interrupted(lease_seconds))
            .where(agent_jobs_table.c.locked_by.is_distinct_from(locked_by))
            .where(agent_jobs_table.c.attempt + 1 < max_attempts)
            .values(
                locked_by=locked_by,
                heartbeat_at=func.now(),
                attempt=agent_jobs_table.c.attempt + 1,
            )
            .returning(agent_jobs_table)
        )
        return await self._all(stmt)

    async def fail_exhausted(self, *, lease_seconds: int, max_attempts: int) -> tuple[JobRow, ...]:
        stmt = (
            update(agent_jobs_table)
            .where(_interrupted(lease_seconds))
            .where(agent_jobs_table.c.attempt + 1 >= max_attempts)
            .values(
                status="failed",
                finished_at=func.now(),
                locked_by=None,
                interrupt_reason=f"中断 {max_attempts} 次后放弃续跑",
            )
            .returning(agent_jobs_table)
        )
        rows = await self._all(stmt)
        for row in rows:
            self._changed(row, "failed")
        return rows

    async def adopt_steered(self, old_run_id: str, new_run_id: str) -> None:
        stmt = (
            update(agent_jobs_table)
            .where(agent_jobs_table.c.status == "steered")
            .where(agent_jobs_table.c.run_id == old_run_id)
            .values(run_id=new_run_id)
        )
        await self._all(stmt.returning(agent_jobs_table))

    async def await_approvals(
        self, prompt_id: str, *, locked_by: str, attempt: int
    ) -> JobRow | None:
        stmt = (
            update(agent_jobs_table)
            .where(_owned(prompt_id, locked_by, attempt))
            .where(agent_jobs_table.c.status == "running")
            .values(status="awaiting", locked_by=None, heartbeat_at=None)
            .returning(agent_jobs_table)
        )
        row = await self._one(stmt)
        if row is not None:
            self._changed(row, "awaiting")
        return row

    async def record_decision(self, prompt_id: str, tool_call_id: str, *, approved: bool) -> JobRow:
        async with self._engine.begin() as conn:
            current = (
                await conn.execute(
                    select(agent_jobs_table)
                    .where(agent_jobs_table.c.prompt_id == prompt_id)
                    .where(agent_jobs_table.c.status == "awaiting")
                    .with_for_update()
                )
            ).one_or_none()
            if current is None:
                raise NotFound(f"这条消息没在等审批：{prompt_id}")
            decisions = dict(_row(current).decisions)
            settled = decisions.get(tool_call_id)
            if settled is not None:
                if settled != approved:
                    raise Conflict("这张审批卡已经回过了，改不了")
                return _row(current)
            decisions[tool_call_id] = approved
            updated = (
                await conn.execute(
                    update(agent_jobs_table)
                    .where(agent_jobs_table.c.prompt_id == prompt_id)
                    .values(decisions=json.dumps(decisions, ensure_ascii=False))
                    .returning(agent_jobs_table)
                )
            ).one()
        return _row(updated)

    async def claim_for_continuation(self, prompt_id: str, *, locked_by: str) -> JobRow | None:
        stmt = (
            update(agent_jobs_table)
            .where(agent_jobs_table.c.prompt_id == prompt_id)
            .where(agent_jobs_table.c.status == "awaiting")
            .values(status="running", locked_by=locked_by, heartbeat_at=func.now())
            .returning(agent_jobs_table)
        )
        row = await self._one(stmt)
        if row is not None:
            self._changed(row, "running")
        return row

    async def conversations_waiting(self) -> tuple[str, ...]:
        queued = agent_jobs_table.alias("queued")
        running = (
            select(agent_jobs_table.c.prompt_id)
            .where(agent_jobs_table.c.conversation_id == queued.c.conversation_id)
            .where(agent_jobs_table.c.status.in_(_ACTIVE))
        )
        stmt = (
            select(queued.c.conversation_id)
            .where(queued.c.status == "queued")
            .where(~exists(running))
            .distinct()
        )
        async with self._engine.connect() as conn:
            return tuple((await conn.execute(stmt)).scalars().all())

    async def _one(self, stmt: Executable) -> JobRow | None:
        async with self._engine.begin() as conn:
            row = (await conn.execute(stmt)).one_or_none()
        return None if row is None else _row(row)

    async def _all(self, stmt: Executable) -> tuple[JobRow, ...]:
        async with self._engine.begin() as conn:
            return tuple(_row(row) for row in (await conn.execute(stmt)).all())

    async def _rows(self, stmt: Executable) -> tuple[JobRow, ...]:
        async with self._engine.connect() as conn:
            return tuple(_row(row) for row in (await conn.execute(stmt)).all())


def _owned(prompt_id: str, locked_by: str, attempt: int) -> ColumnElement[bool]:
    return and_(
        agent_jobs_table.c.prompt_id == prompt_id,
        agent_jobs_table.c.locked_by == locked_by,
        agent_jobs_table.c.attempt == attempt,
    )


def _interrupted(lease_seconds: int) -> ColumnElement[bool]:
    return and_(
        agent_jobs_table.c.status == "running",
        or_(
            agent_jobs_table.c.locked_by.is_(None),
            agent_jobs_table.c.heartbeat_at < func.now() - timedelta(seconds=lease_seconds),
        ),
    )


_CONTENT = TypeAdapter(tuple[PromptContent, ...])
_DECISIONS = TypeAdapter(dict[str, bool])


def _dump(content: tuple[PromptContent, ...]) -> str:
    return json.dumps(
        [part.model_dump(by_alias=True, exclude_none=True) for part in content],
        ensure_ascii=False,
    )


class _JobRow:
    prompt_id: str
    conversation_id: str
    agent_id: str
    owner_user_id: uuid.UUID
    user_name: str
    content: str
    status: str
    run_id: str | None
    created_at: datetime
    finished_at: datetime | None
    steered_at: datetime | None
    locked_by: str | None
    heartbeat_at: datetime | None
    interrupt_reason: str | None
    attempt: int
    decisions: str | None


def _row(row: object) -> JobRow:
    r = cast("_JobRow", row)
    return JobRow(
        prompt_id=r.prompt_id,
        conversation_id=r.conversation_id,
        agent_id=r.agent_id,
        owner_user_id=r.owner_user_id,
        user_name=r.user_name,
        content=_CONTENT.validate_json(r.content),
        status=cast("JobStatus", r.status),
        run_id=r.run_id,
        created_at=r.created_at,
        finished_at=r.finished_at,
        steered_at=r.steered_at,
        locked_by=r.locked_by,
        heartbeat_at=r.heartbeat_at,
        interrupt_reason=r.interrupt_reason,
        attempt=r.attempt,
        decisions={} if r.decisions is None else _DECISIONS.validate_json(r.decisions),
    )


__all__ = [
    "DB_SCHEMA",
    "STEERED_ABORT_CONFLICT",
    "ActivityChanged",
    "JobQueue",
    "JobQueueView",
    "JobRow",
    "Submission",
    "agent_job_runs_table",
    "agent_jobs_table",
    "metadata_obj",
]
