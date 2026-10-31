"""运行时会话：一段对话在运行时这一侧的那一行，记着它归哪个接入应用、固定用哪个 agent 版本。

会话 id 等于对话 id。会话在建对话时开，归开它的应用，之后应用与版本都不再变；分叉出来的会话照抄源会话的
版本，归发起分叉的应用。运行开始时按这里的
版本装配，没有这一行或版本为空就是装不起来。本表不加指向对话表与用户表的外键：运行时与产品记录分开存。"""

from __future__ import annotations

import uuid
from collections import OrderedDict
from collections.abc import Collection
from typing import Final

from sqlalchemy import Column, MetaData, Table, Text, Uuid, func, literal, select
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
    Column("created_at", TIMESTAMP(timezone=True), nullable=False, server_default=func.now()),
)

_ROWS = sessions_table.c


class PgSessionStore:
    """``agent_runtime.sessions`` 的读写。"""

    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def open(
        self, session_id: uuid.UUID, *, app_id: str, agent_version_id: uuid.UUID | None
    ) -> bool:
        """给 ``app_id`` 开一个会话，固定在 ``agent_version_id``；这个 id 已归别的应用时什么都不写、回
        ``False``。

        只在应用还没有自己的记录时调用（会话先开、记录后落）：这个 id 已有同一应用的会话说明上次落记录
        失败了，那一行不属于任何记录，按这次的版本改写。"""

        statement = pg_insert(sessions_table).values(
            id=session_id, app_id=app_id, agent_version_id=agent_version_id
        )
        async with self._engine.begin() as conn:
            written = await conn.execute(
                statement.on_conflict_do_update(
                    index_elements=[_ROWS.id],
                    set_={"agent_version_id": statement.excluded.agent_version_id},
                    where=_ROWS.app_id == statement.excluded.app_id,
                ).returning(_ROWS.id)
            )
            return written.first() is not None

    async def copy(self, source_id: uuid.UUID, target_id: uuid.UUID, *, app_id: str) -> bool:
        """照抄源会话的版本给 ``app_id`` 开一个新会话；源没有会话时新会话的版本为空（运行时装不起来）。

        目标 id 是新铸的，已有同一应用的会话就保持原样；已归别的应用时什么都不写、回 ``False``。"""

        version = select(_ROWS.agent_version_id).where(_ROWS.id == source_id).scalar_subquery()
        statement = pg_insert(sessions_table).from_select(
            ["id", "app_id", "agent_version_id"],
            select(literal(target_id, Uuid), literal(app_id, Text), version),
        )
        async with self._engine.begin() as conn:
            written = await conn.execute(
                statement.on_conflict_do_update(
                    index_elements=[_ROWS.id],
                    # 原样写回：只为让同一应用已有的那一行也出现在 RETURNING 里，与别的应用的区分开。
                    set_={"agent_version_id": _ROWS.agent_version_id},
                    where=_ROWS.app_id == statement.excluded.app_id,
                ).returning(_ROWS.id)
            )
            return written.first() is not None

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

    async def agent_version(self, session_id: uuid.UUID) -> uuid.UUID | None:
        """会话固定的版本；没有这个会话、或它的版本为空都给 ``None``。"""

        async with self._engine.connect() as conn:
            return (
                await conn.execute(select(_ROWS.agent_version_id).where(_ROWS.id == session_id))
            ).scalar_one_or_none()

    async def app_of(self, session_id: uuid.UUID) -> str | None:
        """会话归哪个应用；没有这个会话给 ``None``。"""

        async with self._engine.connect() as conn:
            return (
                await conn.execute(select(_ROWS.app_id).where(_ROWS.id == session_id))
            ).scalar_one_or_none()


SESSION_APPS_CACHE_SIZE: Final = 4096
"""``SessionApps`` 最多记住多少段会话的归属。"""


class SessionApps:
    """按会话 id 查它归哪个应用，记住查到的结果。

    会话的应用开了就不再变，所以查到的可以一直用；没查到的不记，会话随后开了照样查得到。事件推送与回调
    每次都要按会话找应用，这里省掉每次一查。"""

    def __init__(self, store: PgSessionStore, *, size: int = SESSION_APPS_CACHE_SIZE) -> None:
        self._store = store
        self._size = size
        # 插入顺序当 LRU，命中时移到末尾。
        self._known: OrderedDict[str, str] = OrderedDict()

    async def app_of(self, session_id: str) -> str | None:
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
        found = await self._store.app_of(parsed)
        if found is not None:
            self._known[key] = found
            if len(self._known) > self._size:
                self._known.popitem(last=False)
        return found


__all__ = [
    "DB_SCHEMA",
    "SESSION_APPS_CACHE_SIZE",
    "PgSessionStore",
    "SessionApps",
    "metadata_obj",
    "sessions_table",
]
