"""运行时会话：一段对话在运行时这一侧的那一行，记着它固定用哪个 agent 版本。

会话 id 等于对话 id。会话在建对话时开，之后版本不再变；分叉出来的会话照抄源会话的版本。运行开始时按这里的
版本装配，没有这一行或版本为空就是装不起来。本表不加指向对话表与用户表的外键：运行时与产品记录分开存。"""

from __future__ import annotations

import uuid
from typing import Final

from sqlalchemy import Column, MetaData, Table, Uuid, func, literal, select
from sqlalchemy.dialects.postgresql import TIMESTAMP
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncEngine

DB_SCHEMA: Final = "agent_runtime"

metadata_obj = MetaData(schema=DB_SCHEMA)

sessions_table = Table(
    "sessions",
    metadata_obj,
    Column("id", Uuid, primary_key=True),
    # 迁移里外键指向 iclip.agent_versions；这份元数据只给本模块读写，不声明跨 schema 的外键。
    Column("agent_version_id", Uuid, nullable=True),
    Column("created_at", TIMESTAMP(timezone=True), nullable=False, server_default=func.now()),
)

_ROWS = sessions_table.c


class PgSessionStore:
    """``agent_runtime.sessions`` 的读写。"""

    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def open(self, session_id: uuid.UUID, *, agent_version_id: uuid.UUID | None) -> None:
        """开一个会话，固定在 ``agent_version_id``。

        只在还没有对话行时调用（会话先开、对话行后落）：这个 id 已有会话说明上次落对话行失败了，那一行
        不属于任何对话，按这次的版本改写。"""

        statement = pg_insert(sessions_table).values(
            id=session_id, agent_version_id=agent_version_id
        )
        async with self._engine.begin() as conn:
            await conn.execute(
                statement.on_conflict_do_update(
                    index_elements=[_ROWS.id],
                    set_={"agent_version_id": statement.excluded.agent_version_id},
                )
            )

    async def copy(self, source_id: uuid.UUID, target_id: uuid.UUID) -> None:
        """照抄源会话的版本开一个新会话；源没有会话时新会话的版本为空（运行时装不起来）。目标 id 是新铸的，
        已有会话就保持原样。"""

        version = select(_ROWS.agent_version_id).where(_ROWS.id == source_id).scalar_subquery()
        async with self._engine.begin() as conn:
            await conn.execute(
                pg_insert(sessions_table)
                .from_select(
                    ["id", "agent_version_id"],
                    select(literal(target_id, Uuid), version),
                )
                .on_conflict_do_nothing(index_elements=[_ROWS.id])
            )

    async def agent_version(self, session_id: uuid.UUID) -> uuid.UUID | None:
        """会话固定的版本；没有这个会话、或它的版本为空都给 ``None``。"""

        async with self._engine.connect() as conn:
            return (
                await conn.execute(select(_ROWS.agent_version_id).where(_ROWS.id == session_id))
            ).scalar_one_or_none()


__all__ = ["DB_SCHEMA", "PgSessionStore", "metadata_obj", "sessions_table"]
