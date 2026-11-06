from __future__ import annotations

from typing import Final

from sqlalchemy import (
    BigInteger,
    Column,
    Index,
    MetaData,
    PrimaryKeyConstraint,
    Table,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import TIMESTAMP
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncEngine

from agent_runtime.transcript.ops import StepUsage

DB_SCHEMA: Final = "agent_runtime"

metadata_obj = MetaData(schema=DB_SCHEMA)

conversation_usage_table = Table(
    "conversation_usage",
    metadata_obj,
    Column("conversation_id", Text, nullable=False),
    Column("model_name", Text, nullable=False),
    Column("requests", BigInteger, nullable=False),
    Column("input_tokens", BigInteger, nullable=False),
    Column("cache_read_tokens", BigInteger, nullable=False),
    Column("cache_write_tokens", BigInteger, nullable=False),
    Column("output_tokens", BigInteger, nullable=False),
    Column("first_at", TIMESTAMP(timezone=True), nullable=False),
    Column("last_at", TIMESTAMP(timezone=True), nullable=False),
    PrimaryKeyConstraint("conversation_id", "model_name"),
    Index("idx_conversation_usage_last", "last_at"),
)


class PgConversationUsage:
    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def add(self, *, conversation_id: str, model_name: str, usage: StepUsage) -> None:
        stmt = pg_insert(conversation_usage_table).values(
            conversation_id=conversation_id,
            model_name=model_name,
            requests=1,
            input_tokens=usage.input_other,
            cache_read_tokens=usage.input_cache_read,
            cache_write_tokens=usage.input_cache_creation,
            output_tokens=usage.output,
            first_at=func.now(),
            last_at=func.now(),
        )
        current = conversation_usage_table.c
        stmt = stmt.on_conflict_do_update(
            index_elements=[current.conversation_id, current.model_name],
            set_={
                "requests": current.requests + 1,
                "input_tokens": current.input_tokens + stmt.excluded.input_tokens,
                "cache_read_tokens": current.cache_read_tokens + stmt.excluded.cache_read_tokens,
                "cache_write_tokens": current.cache_write_tokens + stmt.excluded.cache_write_tokens,
                "output_tokens": current.output_tokens + stmt.excluded.output_tokens,
                "last_at": func.now(),
            },
        )
        async with self._engine.begin() as conn:
            await conn.execute(stmt)


__all__ = ["PgConversationUsage", "conversation_usage_table"]
