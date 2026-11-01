"""运行时会话：一段对话在运行时这一侧的那一行，记着它归哪个接入应用、固定用哪个 agent 版本。

会话 id 等于对话 id。会话在建对话时开，归开它的应用，之后应用与版本都不再变；分叉出来的会话照抄源会话的
版本，归发起分叉的应用。运行开始时按这里的
版本装配，没有这一行或版本为空就是装不起来。本表不加指向对话表与用户表的外键：运行时与产品记录分开存。

**预览会话**是 ``preview_agent_id`` 有值的那些：管理员拿某个 agent 的草稿（版本为空）或它的某一版试聊，
不是对话。开了以后是不是预览、预览哪个 agent 都不再变；不能分叉、不能当拷文件的源或目标，统计也不算它们。"""

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
    # 外键（指向 agent_versions）由迁移建；这份元数据只给本模块读写，不引用 agent 配置的表定义。
    Column("agent_version_id", Uuid, nullable=True),
    # 外键（指向 agents）由迁移建。有值即预览会话；版本为空时每次运行装这个 agent 当下的草稿。
    Column("preview_agent_id", Text, nullable=True),
    Column("created_at", TIMESTAMP(timezone=True), nullable=False, server_default=func.now()),
)

_ROWS = sessions_table.c


@dataclass(frozen=True, slots=True)
class SessionTarget:
    """会话每次运行装哪一份：``preview_agent_id`` 为空是普通会话，按 ``agent_version_id`` 装（为空就装不
    起来）；有值是预览，版本为空装那个 agent 的草稿，否则装那一版。"""

    agent_version_id: uuid.UUID | None
    preview_agent_id: str | None


@dataclass(frozen=True, slots=True)
class SessionInfo:
    """会话开了就不再变的两件事：归哪个应用、是不是预览。"""

    app_id: str
    preview: bool


class PgSessionStore:
    """``agent_runtime.sessions`` 的读写。"""

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
        """给 ``app_id`` 开一个会话，固定在 ``agent_version_id``；``preview_agent_id`` 有值就是预览那个
        agent 的会话。这个 id 已归别的应用、或已有的那一行与这次一个是预览一个不是（或预览的不是同一个
        agent）时什么都不写、回 ``False``。

        只在应用还没有自己的记录时调用（会话先开、记录后落）：这个 id 已有同一应用、同一种的会话说明上次
        落记录失败了，那一行不属于任何记录，按这次的版本改写。是不是预览不改写，所以开了以后不再变。"""

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
        """照抄源会话的版本给 ``app_id`` 开一个新会话；源没有会话时新会话的版本为空（运行时装不起来）。

        目标 id 是新铸的，已有同一应用的普通会话就保持原样；已归别的应用、或已是预览会话时什么都不写、
        回 ``False``。新会话总是普通会话：调用方先挡掉预览的源。"""

        version = select(_ROWS.agent_version_id).where(_ROWS.id == source_id).scalar_subquery()
        statement = pg_insert(sessions_table).from_select(
            ["id", "app_id", "agent_version_id", "preview_agent_id"],
            select(literal(target_id, Uuid), literal(app_id, Text), version, null()),
        )
        async with self._engine.begin() as conn:
            written = await conn.execute(
                statement.on_conflict_do_update(
                    index_elements=[_ROWS.id],
                    # 原样写回：只为让同一应用已有的那一行也出现在 RETURNING 里，与别的应用的区分开。
                    set_={"agent_version_id": _ROWS.agent_version_id},
                    where=(_ROWS.app_id == statement.excluded.app_id)
                    & _ROWS.preview_agent_id.is_(None),
                ).returning(_ROWS.id)
            )
            return written.first() is not None

    async def previews(self, session_ids: Collection[uuid.UUID]) -> frozenset[uuid.UUID]:
        """``session_ids`` 里是预览会话的那些；没有会话的不在结果里。"""

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
        """会话每次运行装哪一份；没有这个会话给 ``None``。"""

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
        """``session_ids`` 里归 ``app_id`` 的那些；没有会话、归别的应用的都不在结果里。"""

        if not session_ids:
            return frozenset()
        async with self._engine.connect() as conn:
            found = await conn.execute(
                select(_ROWS.id).where(_ROWS.id.in_(session_ids), _ROWS.app_id == app_id)
            )
            return frozenset(found.scalars())

    async def info_of(self, session_id: uuid.UUID) -> SessionInfo | None:
        """会话归哪个应用、是不是预览；没有这个会话给 ``None``。"""

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
"""``SessionApps`` 最多记住多少段会话的归属。"""


class SessionApps:
    """按会话 id 查它归哪个应用、是不是预览，记住查到的结果。

    这两件事开了就不再变，所以查到的可以一直用；没查到的不记，会话随后开了照样查得到。事件推送与回调
    每次都要按会话找应用，这里省掉每次一查。"""

    def __init__(self, store: PgSessionStore, *, size: int = SESSION_APPS_CACHE_SIZE) -> None:
        self._store = store
        self._size = size
        # 插入顺序当 LRU，命中时移到末尾。
        self._known: OrderedDict[str, SessionInfo] = OrderedDict()

    async def info_of(self, session_id: str) -> SessionInfo | None:
        """``session_id`` 不是 UUID 或没有这个会话都给 ``None``。"""

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
        """会话归哪个应用；``session_id`` 不是 UUID 或没有这个会话都给 ``None``。"""

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
