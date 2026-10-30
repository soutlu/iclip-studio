"""Agent 配置的六张表与它们的 Postgres 仓储。

时间统一用数据库时钟；外部输入一律走绑定参数。状态与操作种类的取值、配置格式与版本号递增只在 Python 里，
表上不加 CHECK；``active_version_id`` 不加外键，只由发布的事务在同一 agent 的行锁下改。"""

from __future__ import annotations

import uuid
from collections import defaultdict
from collections.abc import AsyncGenerator, Mapping, Sequence
from contextlib import asynccontextmanager
from typing import Any, Final

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Integer,
    MetaData,
    PrimaryKeyConstraint,
    Table,
    Text,
    UniqueConstraint,
    Uuid,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.engine import RowMapping
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from iclip.common.errors import Conflict, NotFound
from iclip.domains.agent_config.config import config_refs
from iclip.domains.agent_config.models import (
    STATUS_ACTIVE,
    Agent,
    AgentDraft,
    AgentRefs,
    AgentState,
    AgentStatus,
    AgentVersion,
    RevisionOperation,
)
from iclip.domains.agent_config.repository import ImportedAgent

DB_SCHEMA: Final = "iclip"

metadata_obj = MetaData(schema=DB_SCHEMA)

agents_table = Table(
    "agents",
    metadata_obj,
    Column("id", Text, primary_key=True),
    Column("name", Text, nullable=False),
    Column("description", Text, nullable=False),
    Column("status", Text, nullable=False),
    Column("listed", Boolean, nullable=False),
    Column("sort_order", Integer, nullable=False),
    Column("active_version_id", Uuid, nullable=True),
    Column("created_by", Uuid, ForeignKey(f"{DB_SCHEMA}.users.id"), nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False, server_default=text("now()")),
    Column("updated_at", DateTime(timezone=True), nullable=False, server_default=text("now()")),
)

agent_drafts_table = Table(
    "agent_drafts",
    metadata_obj,
    Column("agent_id", Text, ForeignKey(f"{DB_SCHEMA}.agents.id"), primary_key=True),
    Column("config", JSONB, nullable=False),
    Column("base_version_id", Uuid, nullable=True),
    Column("lock_version", Integer, nullable=False),
    Column("updated_by", Uuid, ForeignKey(f"{DB_SCHEMA}.users.id"), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False, server_default=text("now()")),
)

agent_versions_table = Table(
    "agent_versions",
    metadata_obj,
    Column("id", Uuid, primary_key=True),
    Column("agent_id", Text, ForeignKey(f"{DB_SCHEMA}.agents.id"), nullable=False),
    Column("version", Integer, nullable=False),
    Column("config", JSONB, nullable=False),
    Column("note", Text, nullable=True),
    Column("created_by", Uuid, ForeignKey(f"{DB_SCHEMA}.users.id"), nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False, server_default=text("now()")),
    UniqueConstraint("agent_id", "version", name="uq_agent_versions_agent_version"),
)

agent_revisions_table = Table(
    "agent_revisions",
    metadata_obj,
    Column("id", Uuid, primary_key=True),
    Column("agent_id", Text, ForeignKey(f"{DB_SCHEMA}.agents.id"), nullable=False),
    Column("operation", Text, nullable=False),
    Column("from_version_id", Uuid, nullable=True),
    Column("to_version_id", Uuid, nullable=True),
    Column("actor_id", Uuid, ForeignKey(f"{DB_SCHEMA}.users.id"), nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False, server_default=text("now()")),
)

agent_skill_bindings_table = Table(
    "agent_skill_bindings",
    metadata_obj,
    Column("agent_id", Text, ForeignKey(f"{DB_SCHEMA}.agents.id"), nullable=False),
    Column("skill_id", Uuid, ForeignKey(f"{DB_SCHEMA}.skills.id"), nullable=False),
    Column("priority", Integer, nullable=False),
    PrimaryKeyConstraint("agent_id", "skill_id"),
)

agent_version_skills_table = Table(
    "agent_version_skills",
    metadata_obj,
    Column("version_id", Uuid, ForeignKey(f"{DB_SCHEMA}.agent_versions.id"), nullable=False),
    Column("skill_id", Uuid, ForeignKey(f"{DB_SCHEMA}.skills.id"), nullable=False),
    Column("priority", Integer, nullable=False),
    PrimaryKeyConstraint("version_id", "skill_id"),
)

_DUPLICATE_ID: Final = "agents_pkey"

_STATE_COLUMNS: Final = """
a.id, a.name, a.description, a.status, a.listed, a.sort_order, a.active_version_id, a.created_by,
a.created_at, a.updated_at,
d.config AS draft_config, d.base_version_id, d.lock_version, d.updated_by AS draft_updated_by,
d.updated_at AS draft_updated_at,
v.version AS active_version, v.config AS active_config, v.note AS active_note,
v.created_by AS active_created_by, v.created_at AS active_created_at
FROM iclip.agents a
JOIN iclip.agent_drafts d ON d.agent_id = a.id
LEFT JOIN iclip.agent_versions v ON v.id = a.active_version_id"""

_ORDER: Final = "ORDER BY a.sort_order, a.created_at DESC, a.id DESC"

_LIST: Final = text(f"SELECT {_STATE_COLUMNS} {_ORDER}")
_GET: Final = text(f"SELECT {_STATE_COLUMNS} WHERE a.id = :id")
_LOCK: Final = text(f"SELECT {_STATE_COLUMNS} WHERE a.id = :id FOR UPDATE OF a, d")

_ALL_BINDINGS: Final = text("""
SELECT agent_id, skill_id FROM iclip.agent_skill_bindings ORDER BY agent_id, priority""")
_BINDINGS: Final = text("""
SELECT skill_id FROM iclip.agent_skill_bindings WHERE agent_id = :agent_id ORDER BY priority""")
_VERSION_SKILLS: Final = text("""
SELECT version_id, skill_id FROM iclip.agent_version_skills
WHERE version_id = ANY(:ids) ORDER BY version_id, priority""")

_VERSION_COLUMNS: Final = """
id, agent_id, version, config, note, created_by, created_at FROM iclip.agent_versions"""
_VERSIONS: Final = text(
    f"SELECT {_VERSION_COLUMNS} WHERE agent_id = :agent_id ORDER BY version DESC"
)
_VERSION: Final = text(f"SELECT {_VERSION_COLUMNS} WHERE agent_id = :agent_id AND id = :id")

_NEXT_VERSION: Final = text("""
SELECT coalesce(max(version), 0) + 1 FROM iclip.agent_versions WHERE agent_id = :agent_id""")
_NEXT_SORT_ORDER: Final = text("SELECT coalesce(max(sort_order), -1) + 1 FROM iclip.agents")

_CLEAR_BINDINGS: Final = text("DELETE FROM iclip.agent_skill_bindings WHERE agent_id = :agent_id")

_POINT_TO: Final = text("""
UPDATE iclip.agents SET active_version_id = :version_id, updated_at = now() WHERE id = :id""")
_DRAFT_BASE: Final = text("""
UPDATE iclip.agent_drafts SET base_version_id = :version_id WHERE agent_id = :agent_id""")

_REORDER: Final = text("""
UPDATE iclip.agents a SET sort_order = o.position - 1, updated_at = now()
FROM unnest(CAST(:ids AS text[])) WITH ORDINALITY AS o(id, position)
WHERE a.id = o.id""")


def _agent_of(row: RowMapping) -> Agent:
    status: AgentStatus = row["status"]
    return Agent(
        id=row["id"],
        name=row["name"],
        description=row["description"],
        status=status,
        listed=row["listed"],
        sort_order=row["sort_order"],
        active_version_id=row["active_version_id"],
        active_version=row["active_version"],
        active_published_at=row["active_created_at"],
        created_by=row["created_by"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _state_of(
    row: RowMapping, draft_skills: Sequence[uuid.UUID], active_skills: Sequence[uuid.UUID]
) -> AgentState:
    agent = _agent_of(row)
    draft = AgentDraft(
        agent_id=agent.id,
        config=row["draft_config"],
        skill_ids=tuple(draft_skills),
        base_version_id=row["base_version_id"],
        lock_version=row["lock_version"],
        updated_by=row["draft_updated_by"],
        updated_at=row["draft_updated_at"],
    )
    active = None
    if agent.active_version_id is not None:
        active = AgentVersion(
            id=agent.active_version_id,
            agent_id=agent.id,
            version=row["active_version"],
            config=row["active_config"],
            skill_ids=tuple(active_skills),
            note=row["active_note"],
            created_by=row["active_created_by"],
            created_at=row["active_created_at"],
        )
    return AgentState(agent=agent, draft=draft, active=active)


def _version_of(row: RowMapping, skill_ids: Sequence[uuid.UUID]) -> AgentVersion:
    return AgentVersion(
        id=row["id"],
        agent_id=row["agent_id"],
        version=row["version"],
        config=row["config"],
        skill_ids=tuple(skill_ids),
        note=row["note"],
        created_by=row["created_by"],
        created_at=row["created_at"],
    )


def _violated_constraint(error: IntegrityError) -> str:
    """违反的约束名；asyncpg 把它挂在被包起来的原异常上。"""

    cause = getattr(error.orig, "__cause__", None)
    return getattr(cause, "constraint_name", None) or ""


async def _version_skills(
    conn: AsyncConnection, version_ids: Sequence[uuid.UUID]
) -> dict[uuid.UUID, list[uuid.UUID]]:
    found: dict[uuid.UUID, list[uuid.UUID]] = defaultdict(list)
    if version_ids:
        for row in (await conn.execute(_VERSION_SKILLS, {"ids": list(version_ids)})).mappings():
            found[row["version_id"]].append(row["skill_id"])
    return found


async def _states(conn: AsyncConnection, rows: Sequence[RowMapping]) -> tuple[AgentState, ...]:
    bindings: dict[str, list[uuid.UUID]] = defaultdict(list)
    for row in (await conn.execute(_ALL_BINDINGS)).mappings():
        bindings[row["agent_id"]].append(row["skill_id"])
    active = await _version_skills(
        conn, [row["active_version_id"] for row in rows if row["active_version_id"] is not None]
    )
    return tuple(
        _state_of(row, bindings[row["id"]], active.get(row["active_version_id"], []))
        for row in rows
    )


async def _state(conn: AsyncConnection, row: RowMapping) -> AgentState:
    draft_skills = [
        skill_id for (skill_id,) in await conn.execute(_BINDINGS, {"agent_id": row["id"]})
    ]
    active_id = row["active_version_id"]
    active = await _version_skills(conn, [active_id] if active_id is not None else [])
    return _state_of(row, draft_skills, active.get(active_id, []) if active_id else [])


async def _insert_bindings(
    conn: AsyncConnection, agent_id: str, skill_ids: Sequence[uuid.UUID]
) -> None:
    if skill_ids:
        await conn.execute(
            agent_skill_bindings_table.insert(),
            [
                {"agent_id": agent_id, "skill_id": skill_id, "priority": priority}
                for priority, skill_id in enumerate(skill_ids)
            ],
        )


async def _record(
    conn: AsyncConnection,
    agent_id: str,
    operation: RevisionOperation,
    *,
    by: uuid.UUID,
    from_version_id: uuid.UUID | None = None,
    to_version_id: uuid.UUID | None = None,
) -> None:
    await conn.execute(
        agent_revisions_table.insert().values(
            id=uuid.uuid4(),
            agent_id=agent_id,
            operation=operation,
            from_version_id=from_version_id,
            to_version_id=to_version_id,
            actor_id=by,
        )
    )


async def _insert_agent(
    conn: AsyncConnection,
    agent_id: str,
    *,
    name: str,
    description: str,
    listed: bool,
    config: Mapping[str, Any],
    skill_ids: Sequence[uuid.UUID],
    by: uuid.UUID,
) -> None:
    sort_order = (await conn.execute(_NEXT_SORT_ORDER)).scalar_one()
    await conn.execute(
        agents_table.insert().values(
            id=agent_id,
            name=name,
            description=description,
            status=STATUS_ACTIVE,
            listed=listed,
            sort_order=sort_order,
            created_by=by,
        )
    )
    await conn.execute(
        agent_drafts_table.insert().values(
            agent_id=agent_id, config=config, lock_version=0, updated_by=by
        )
    )
    await _insert_bindings(conn, agent_id, skill_ids)


class _SqlAgentWriter:
    """``AgentWriter`` 的 Postgres 实现，用一条已锁住 agent 行与草稿行的事务连接。"""

    def __init__(self, conn: AsyncConnection, state: AgentState) -> None:
        self._conn = conn
        self._state = state

    @property
    def state(self) -> AgentState:
        return self._state

    @property
    def _agent_id(self) -> str:
        return self._state.agent.id

    async def version(self, version_id: uuid.UUID) -> AgentVersion | None:
        row = (
            (await self._conn.execute(_VERSION, {"agent_id": self._agent_id, "id": version_id}))
            .mappings()
            .first()
        )
        if row is None:
            return None
        skills = await _version_skills(self._conn, [version_id])
        return _version_of(row, skills.get(version_id, []))

    async def update(
        self,
        *,
        name: str | None = None,
        description: str | None = None,
        listed: bool | None = None,
        status: AgentStatus | None = None,
    ) -> None:
        values: dict[str, Any] = {
            key: value
            for key, value in (
                ("name", name),
                ("description", description),
                ("listed", listed),
                ("status", status),
            )
            if value is not None
        }
        if values:
            await self._conn.execute(
                agents_table.update()
                .where(agents_table.c.id == self._agent_id)
                .values(**values, updated_at=text("now()"))
            )

    async def replace_draft(
        self,
        config: Mapping[str, Any],
        skill_ids: Sequence[uuid.UUID],
        *,
        base_version_id: uuid.UUID | None,
        by: uuid.UUID,
    ) -> AgentDraft:
        table = agent_drafts_table
        row = (
            (
                await self._conn.execute(
                    table.update()
                    .where(table.c.agent_id == self._agent_id)
                    .values(
                        config=config,
                        base_version_id=base_version_id,
                        lock_version=table.c.lock_version + 1,
                        updated_by=by,
                        updated_at=text("now()"),
                    )
                    .returning(table.c.lock_version, table.c.updated_at)
                )
            )
            .mappings()
            .one()
        )
        await self._conn.execute(_CLEAR_BINDINGS, {"agent_id": self._agent_id})
        await _insert_bindings(self._conn, self._agent_id, skill_ids)
        return AgentDraft(
            agent_id=self._agent_id,
            config=config,
            skill_ids=tuple(skill_ids),
            base_version_id=base_version_id,
            lock_version=row["lock_version"],
            updated_by=by,
            updated_at=row["updated_at"],
        )

    async def publish(
        self,
        version_id: uuid.UUID,
        *,
        config: Mapping[str, Any],
        skill_ids: Sequence[uuid.UUID],
        note: str | None,
        by: uuid.UUID,
    ) -> None:
        number = (
            await self._conn.execute(_NEXT_VERSION, {"agent_id": self._agent_id})
        ).scalar_one()
        await self._conn.execute(
            agent_versions_table.insert().values(
                id=version_id,
                agent_id=self._agent_id,
                version=number,
                config=config,
                note=note,
                created_by=by,
            )
        )
        if skill_ids:
            await self._conn.execute(
                agent_version_skills_table.insert(),
                [
                    {"version_id": version_id, "skill_id": skill_id, "priority": priority}
                    for priority, skill_id in enumerate(skill_ids)
                ],
            )
        await _record(
            self._conn,
            self._agent_id,
            "publish",
            by=by,
            from_version_id=self._state.agent.active_version_id,
            to_version_id=version_id,
        )
        await self._conn.execute(_POINT_TO, {"id": self._agent_id, "version_id": version_id})
        await self._conn.execute(
            _DRAFT_BASE, {"agent_id": self._agent_id, "version_id": version_id}
        )

    async def record(
        self,
        operation: RevisionOperation,
        *,
        by: uuid.UUID,
        from_version_id: uuid.UUID | None = None,
        to_version_id: uuid.UUID | None = None,
    ) -> None:
        await _record(
            self._conn,
            self._agent_id,
            operation,
            by=by,
            from_version_id=from_version_id,
            to_version_id=to_version_id,
        )


class SqlAgentStore:
    """``AgentStore`` 的 Postgres 实现。"""

    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def list(self) -> tuple[AgentState, ...]:
        async with self._engine.connect() as conn:
            rows = (await conn.execute(_LIST)).mappings().all()
            return await _states(conn, rows)

    async def get(self, agent_id: str) -> AgentState | None:
        async with self._engine.connect() as conn:
            row = (await conn.execute(_GET, {"id": agent_id})).mappings().first()
            return await _state(conn, row) if row is not None else None

    async def versions(self, agent_id: str) -> tuple[AgentVersion, ...]:
        async with self._engine.connect() as conn:
            rows = (await conn.execute(_VERSIONS, {"agent_id": agent_id})).mappings().all()
            skills = await _version_skills(conn, [row["id"] for row in rows])
        return tuple(_version_of(row, skills.get(row["id"], [])) for row in rows)

    async def version(self, agent_id: str, version_id: uuid.UUID) -> AgentVersion | None:
        async with self._engine.connect() as conn:
            row = (
                (await conn.execute(_VERSION, {"agent_id": agent_id, "id": version_id}))
                .mappings()
                .first()
            )
            if row is None:
                return None
            skills = await _version_skills(conn, [version_id])
        return _version_of(row, skills.get(version_id, []))

    async def references(self) -> tuple[AgentRefs, ...]:
        states = await self.list()
        return tuple(
            sorted(
                (
                    AgentRefs(
                        agent_id=state.agent.id,
                        name=state.agent.name,
                        description=state.agent.description,
                        status=state.agent.status,
                        active_version_id=state.agent.active_version_id,
                        draft=config_refs(state.draft.config, state.draft.skill_ids),
                        active=config_refs(state.active.config, state.active.skill_ids)
                        if state.active is not None
                        else None,
                    )
                    for state in states
                ),
                key=lambda refs: refs.agent_id,
            )
        )

    async def create(
        self,
        agent_id: str,
        *,
        name: str,
        description: str,
        config: Mapping[str, Any],
        by: uuid.UUID,
    ) -> None:
        try:
            async with self._engine.begin() as conn:
                await _insert_agent(
                    conn,
                    agent_id,
                    name=name,
                    description=description,
                    listed=False,
                    config=config,
                    skill_ids=(),
                    by=by,
                )
                await _record(conn, agent_id, "create", by=by)
        except IntegrityError as exc:
            if _violated_constraint(exc) == _DUPLICATE_ID:
                raise Conflict(f"已有标识为「{agent_id}」的 agent") from exc
            raise

    async def reorder(self, agent_ids: Sequence[str]) -> None:
        async with self._engine.begin() as conn:
            await conn.execute(_REORDER, {"ids": list(agent_ids)})

    async def import_agents(self, agents: Sequence[ImportedAgent], *, by: uuid.UUID) -> None:
        async with self._engine.begin() as conn:
            for one in agents:
                row = (await conn.execute(_LOCK, {"id": one.agent_id})).mappings().first()
                if row is None:
                    await _insert_agent(
                        conn,
                        one.agent_id,
                        name=one.name,
                        description=one.description,
                        listed=one.listed,
                        config=one.config,
                        skill_ids=one.skill_ids,
                        by=by,
                    )
                else:
                    writer = _SqlAgentWriter(conn, await _state(conn, row))
                    await writer.replace_draft(
                        one.config, one.skill_ids, base_version_id=None, by=by
                    )
                await _record(conn, one.agent_id, "import", by=by)

    @asynccontextmanager
    async def edit(self, agent_id: str) -> AsyncGenerator[_SqlAgentWriter]:
        async with self._engine.begin() as conn:
            row = (await conn.execute(_LOCK, {"id": agent_id})).mappings().first()
            if row is None:
                raise NotFound("agent 不存在")
            yield _SqlAgentWriter(conn, await _state(conn, row))


__all__ = [
    "SqlAgentStore",
    "agent_drafts_table",
    "agent_revisions_table",
    "agent_skill_bindings_table",
    "agent_version_skills_table",
    "agent_versions_table",
    "agents_table",
    "metadata_obj",
]
