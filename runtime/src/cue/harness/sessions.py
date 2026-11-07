from __future__ import annotations

import uuid
from collections import OrderedDict
from collections.abc import Collection
from dataclasses import dataclass
from typing import Final

from sqlalchemy import Column, MetaData, Table, Text, Uuid, func, literal, null, select
from sqlalchemy.dialects.postgresql import TIMESTAMP
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncEngine

DB_SCHEMA: Final = "agent_runtime"

metadata_obj = MetaData(schema=DB_SCHEMA)

sessions_table = Table(
    "sessions",
    metadata_obj,
    Column("id", Uuid, primary_key=True),
    Column("app_id", Text, nullable=False),
    Column("agent_version_id", Uuid, nullable=True),
    Column("preview_agent_id", Text, nullable=True),
    Column("created_at", TIMESTAMP(timezone=True), nullable=False, server_default=func.now()),
)

_ROWS = sessions_table.c


@dataclass(frozen=True, slots=True)
class SessionTarget:
    agent_version_id: uuid.UUID | None
    preview_agent_id: str | None


@dataclass(frozen=True, slots=True)
class SessionInfo:
    app_id: str
    preview: bool


class PgSessionStore:
    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def open(
        self,
        session_id: uuid.UUID,
        *,
        app_id: str,
        agent_version_id: uuid.UUID | None,
        preview_agent_id: str | None = None,
    ) -> bool:
        statement = pg_insert(sessions_table).values(
            id=session_id,
            app_id=app_id,
            agent_version_id=agent_version_id,
            preview_agent_id=preview_agent_id,
        )
        async with self._engine.begin() as conn:
            written = await conn.execute(
                statement.on_conflict_do_update(
                    index_elements=[_ROWS.id],
                    set_={"agent_version_id": statement.excluded.agent_version_id},
                    where=(_ROWS.app_id == statement.excluded.app_id)
                    & _ROWS.preview_agent_id.is_not_distinct_from(
                        statement.excluded.preview_agent_id
                    ),
                ).returning(_ROWS.id)
            )
            return written.first() is not None

    async def copy(self, source_id: uuid.UUID, target_id: uuid.UUID, *, app_id: str) -> bool:
        version = select(_ROWS.agent_version_id).where(_ROWS.id == source_id).scalar_subquery()
        statement = pg_insert(sessions_table).from_select(
            ["id", "app_id", "agent_version_id", "preview_agent_id"],
            select(literal(target_id, Uuid), literal(app_id, Text), version, null()),
        )
        async with self._engine.begin() as conn:
            written = await conn.execute(
                statement.on_conflict_do_update(
                    index_elements=[_ROWS.id],
                    set_={"agent_version_id": _ROWS.agent_version_id},
                    where=(_ROWS.app_id == statement.excluded.app_id)
                    & _ROWS.preview_agent_id.is_(None),
                ).returning(_ROWS.id)
            )
            return written.first() is not None

    async def previews(self, session_ids: Collection[uuid.UUID]) -> frozenset[uuid.UUID]:
        if not session_ids:
            return frozenset()
        async with self._engine.connect() as conn:
            found = await conn.execute(
                select(_ROWS.id).where(
                    _ROWS.id.in_(session_ids), _ROWS.preview_agent_id.is_not(None)
                )
            )
            return frozenset(found.scalars())

    async def target(self, session_id: uuid.UUID) -> SessionTarget | None:
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(
                    select(_ROWS.agent_version_id, _ROWS.preview_agent_id).where(
                        _ROWS.id == session_id
                    )
                )
            ).first()
        if row is None:
            return None
        return SessionTarget(
            agent_version_id=row.agent_version_id, preview_agent_id=row.preview_agent_id
        )

    async def owned(
        self, session_ids: Collection[uuid.UUID], *, app_id: str
    ) -> frozenset[uuid.UUID]:
        if not session_ids:
            return frozenset()
        async with self._engine.connect() as conn:
            found = await conn.execute(
                select(_ROWS.id).where(_ROWS.id.in_(session_ids), _ROWS.app_id == app_id)
            )
            return frozenset(found.scalars())

    async def info_of(self, session_id: uuid.UUID) -> SessionInfo | None:
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(
                    select(_ROWS.app_id, _ROWS.preview_agent_id).where(_ROWS.id == session_id)
                )
            ).first()
        if row is None:
            return None
        return SessionInfo(app_id=row.app_id, preview=row.preview_agent_id is not None)


SESSION_APPS_CACHE_SIZE: Final = 4096


class SessionApps:
    def __init__(self, store: PgSessionStore, *, size: int = SESSION_APPS_CACHE_SIZE) -> None:
        self._store = store
        self._size = size
        self._known: OrderedDict[str, SessionInfo] = OrderedDict()

    async def info_of(self, session_id: str) -> SessionInfo | None:
        try:
            parsed = uuid.UUID(session_id)
        except ValueError:
            return None
        key = str(parsed)
        found = self._known.get(key)
        if found is not None:
            self._known.move_to_end(key)
            return found
        found = await self._store.info_of(parsed)
        if found is not None:
            self._known[key] = found
            if len(self._known) > self._size:
                self._known.popitem(last=False)
        return found

    async def app_of(self, session_id: str) -> str | None:
        found = await self.info_of(session_id)
        return None if found is None else found.app_id


__all__ = [
    "DB_SCHEMA",
    "SESSION_APPS_CACHE_SIZE",
    "PgSessionStore",
    "SessionApps",
    "SessionInfo",
    "SessionTarget",
    "metadata_obj",
    "sessions_table",
]
