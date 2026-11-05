from __future__ import annotations

import uuid
from collections.abc import Sequence
from datetime import datetime
from typing import Final

from agent_runtime.errors import NotFound
from sqlalchemy import (
    CheckConstraint,
    Column,
    ColumnElement,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    MetaData,
    PrimaryKeyConstraint,
    Table,
    Text,
    Uuid,
    and_,
    delete,
    func,
    or_,
    select,
    update,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.engine.row import RowMapping
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from iclip.domains.tasks.models import (
    ACTIVE_STATUSES,
    STATUS_CONFIRMED,
    STATUS_DRAFT,
    STATUS_PUBLISHED,
    TASK_STATUSES,
    Task,
    TaskCursor,
    TaskStatus,
)
from iclip.domains.tasks.schemas import TaskInputs, inputs_from_payload, inputs_to_payload

DB_SCHEMA: Final = "iclip"

metadata_obj = MetaData(schema=DB_SCHEMA)

_STATUS_LIST = ", ".join(f"'{status}'" for status in TASK_STATUSES)

tasks_table = Table(
    "tasks",
    metadata_obj,
    Column("id", Uuid, primary_key=True),
    Column("title", Text, nullable=False),
    Column("status", Text, nullable=False),
    Column("priority", Integer, nullable=False),
    Column("deadline", DateTime(timezone=True), nullable=True),
    Column(
        "creator_user_id",
        Uuid,
        ForeignKey(f"{DB_SCHEMA}.users.id", ondelete="restrict"),
        nullable=False,
    ),
    Column("inputs", JSONB, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
    CheckConstraint(f"status IN ({_STATUS_LIST})", name="tasks_status_check"),
    CheckConstraint("jsonb_typeof(inputs) = 'object'", name="tasks_inputs_object_check"),
)

_ROWS = tasks_table.c

Index("ix_tasks_created", _ROWS.created_at.desc(), _ROWS.id.desc())

_ORDER: Final = (_ROWS.created_at.desc(), _ROWS.id.desc())


def _conditions(
    status: TaskStatus | None,
    assignee_user_id: uuid.UUID | None,
    ids: Sequence[uuid.UUID] | None,
) -> list[ColumnElement[bool]]:
    conditions: list[ColumnElement[bool]] = []
    if status is not None:
        conditions.append(_ROWS.status == status)
    if assignee_user_id is not None:
        conditions.append(
            _ROWS.id.in_(
                select(task_assignees_table.c.task_id).where(
                    task_assignees_table.c.user_id == assignee_user_id
                )
            )
        )
    if ids is not None:
        conditions.append(_ROWS.id.in_(list(ids)))
    return conditions


def _after(cursor: TaskCursor | None) -> list[ColumnElement[bool]]:
    if cursor is None:
        return []
    return [
        or_(
            _ROWS.created_at < cursor.created_at,
            and_(_ROWS.created_at == cursor.created_at, _ROWS.id < cursor.task_id),
        )
    ]


task_assignees_table = Table(
    "task_assignees",
    metadata_obj,
    Column(
        "task_id",
        Uuid,
        ForeignKey(f"{DB_SCHEMA}.tasks.id", ondelete="cascade"),
        nullable=False,
    ),
    Column(
        "user_id",
        Uuid,
        ForeignKey(f"{DB_SCHEMA}.users.id", ondelete="restrict"),
        nullable=False,
    ),
    Column("created_at", DateTime(timezone=True), nullable=False),
    PrimaryKeyConstraint("task_id", "user_id"),
)

Index("ix_task_assignees_user", task_assignees_table.c.user_id)


def _row(mapping: RowMapping, assignee_user_ids: tuple[uuid.UUID, ...] = ()) -> Task:
    return Task(
        id=mapping["id"],
        title=mapping["title"],
        status=mapping["status"],
        priority=mapping["priority"],
        deadline=mapping["deadline"],
        creator_user_id=mapping["creator_user_id"],
        inputs=inputs_from_payload(mapping["inputs"]),
        created_at=mapping["created_at"],
        updated_at=mapping["updated_at"],
        assignee_user_ids=assignee_user_ids,
    )


class SqlTaskRepository:
    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def create_if_absent(self, task: Task) -> tuple[Task, bool]:
        statement = (
            pg_insert(tasks_table)
            .values(
                id=task.id,
                title=task.title,
                status=task.status,
                priority=task.priority,
                deadline=task.deadline,
                creator_user_id=task.creator_user_id,
                inputs=inputs_to_payload(task.inputs),
                created_at=func.now(),
                updated_at=func.now(),
            )
            .on_conflict_do_nothing(index_elements=[_ROWS.id])
            .returning(*tasks_table.c)
        )
        async with self._engine.begin() as conn:
            row = (await conn.execute(statement)).mappings().one_or_none()
        if row is None:
            return await self.get(task.id), False
        return _row(row), True

    async def get(self, task_id: uuid.UUID) -> Task:
        statement = select(tasks_table).where(_ROWS.id == task_id)
        async with self._engine.connect() as conn:
            row = (await conn.execute(statement)).mappings().one_or_none()
            if row is None:
                raise NotFound("没有这张需求单")
            assignees = await self._assignees_of(conn, [task_id])
        return _row(row, assignees.get(task_id, ()))

    async def list_recent(
        self,
        *,
        status: TaskStatus | None = None,
        assignee_user_id: uuid.UUID | None = None,
        ids: Sequence[uuid.UUID] | None = None,
        limit: int,
        after: TaskCursor | None = None,
    ) -> tuple[Task, ...]:
        statement = (
            select(tasks_table)
            .where(*_conditions(status, assignee_user_id, ids), *_after(after))
            .order_by(*_ORDER)
            .limit(limit)
        )
        async with self._engine.connect() as conn:
            rows = (await conn.execute(statement)).mappings().all()
            assignees = await self._assignees_of(conn, [row["id"] for row in rows])
        return tuple(_row(row, assignees.get(row["id"], ())) for row in rows)

    async def count(
        self,
        *,
        status: TaskStatus | None = None,
        assignee_user_id: uuid.UUID | None = None,
        ids: Sequence[uuid.UUID] | None = None,
    ) -> int:
        statement = (
            select(func.count())
            .select_from(tasks_table)
            .where(*_conditions(status, assignee_user_id, ids))
        )
        async with self._engine.connect() as conn:
            return int((await conn.execute(statement)).scalar_one())

    @staticmethod
    async def _assignees_of(
        conn: AsyncConnection, task_ids: list[uuid.UUID]
    ) -> dict[uuid.UUID, tuple[uuid.UUID, ...]]:
        if not task_ids:
            return {}
        statement = (
            select(task_assignees_table.c.task_id, task_assignees_table.c.user_id)
            .where(task_assignees_table.c.task_id.in_(task_ids))
            .order_by(task_assignees_table.c.created_at)
        )
        rows = (await conn.execute(statement)).all()
        grouped: dict[uuid.UUID, list[uuid.UUID]] = {}
        for row in rows:
            grouped.setdefault(row.task_id, []).append(row.user_id)
        return {task_id: tuple(ids) for task_id, ids in grouped.items()}

    async def save(
        self,
        task_id: uuid.UUID,
        *,
        expect: TaskStatus,
        title: str,
        priority: int,
        deadline: datetime | None,
        inputs: TaskInputs,
    ) -> Task | None:
        statement = (
            update(tasks_table)
            .where(_ROWS.id == task_id, _ROWS.status == expect)
            .values(
                title=title,
                priority=priority,
                deadline=deadline,
                inputs=inputs_to_payload(inputs),
                updated_at=func.now(),
            )
            .returning(*tasks_table.c)
        )
        async with self._engine.begin() as conn:
            row = (await conn.execute(statement)).mappings().one_or_none()
            if row is None:
                return None
            assignees = await self._assignees_of(conn, [task_id])
        return _row(row, assignees.get(task_id, ()))

    async def publish(self, task_id: uuid.UUID) -> Task | None:
        statement = (
            update(tasks_table)
            .where(
                _ROWS.id == task_id,
                _ROWS.status == STATUS_DRAFT,
                or_(_ROWS.deadline.is_(None), _ROWS.deadline > func.now()),
            )
            .values(status=STATUS_PUBLISHED, updated_at=func.now())
            .returning(*tasks_table.c)
        )
        async with self._engine.begin() as conn:
            row = (await conn.execute(statement)).mappings().one_or_none()
            if row is None:
                return None
            assignees = await self._assignees_of(conn, [task_id])
        return _row(row, assignees.get(task_id, ()))

    async def confirm(self, task_id: uuid.UUID, *, user_id: uuid.UUID) -> Task | None:
        async with self._engine.begin() as conn:
            current = (
                await conn.execute(
                    select(_ROWS.status).where(_ROWS.id == task_id).with_for_update()
                )
            ).scalar_one_or_none()
            if current not in ACTIVE_STATUSES:
                return None
            await conn.execute(
                pg_insert(task_assignees_table)
                .values(task_id=task_id, user_id=user_id, created_at=func.now())
                .on_conflict_do_nothing()
            )
            row = (
                (
                    await conn.execute(
                        update(tasks_table)
                        .where(_ROWS.id == task_id, _ROWS.status == STATUS_PUBLISHED)
                        .values(status=STATUS_CONFIRMED, updated_at=func.now())
                        .returning(*tasks_table.c)
                    )
                )
                .mappings()
                .one_or_none()
            )
            if row is None:
                row = (
                    (await conn.execute(select(tasks_table).where(_ROWS.id == task_id)))
                    .mappings()
                    .one()
                )
            assignees = await self._assignees_of(conn, [task_id])
        return _row(row, assignees.get(task_id, ()))

    async def set_status(
        self, task_id: uuid.UUID, *, expect: TaskStatus, status: TaskStatus
    ) -> Task | None:
        statement = (
            update(tasks_table)
            .where(_ROWS.id == task_id, _ROWS.status == expect)
            .values(status=status, updated_at=func.now())
            .returning(*tasks_table.c)
        )
        async with self._engine.begin() as conn:
            row = (await conn.execute(statement)).mappings().one_or_none()
            if row is None:
                return None
            assignees = await self._assignees_of(conn, [task_id])
        return _row(row, assignees.get(task_id, ()))

    async def delete(self, task_id: uuid.UUID, *, expect: TaskStatus) -> bool:
        statement = (
            delete(tasks_table)
            .where(_ROWS.id == task_id, _ROWS.status == expect)
            .returning(_ROWS.id)
        )
        async with self._engine.begin() as conn:
            row = (await conn.execute(statement)).first()
        return row is not None


__all__ = [
    "DB_SCHEMA",
    "SqlTaskRepository",
    "metadata_obj",
    "task_assignees_table",
    "tasks_table",
]
