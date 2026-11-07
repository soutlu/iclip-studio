"""Alembic 环境：连接串由 runner 放进 attributes，版本表与自动生成都只在 `agent_runtime` schema。"""

from __future__ import annotations

import asyncio

from alembic import context
from sqlalchemy import text
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import create_async_engine

from agent_runtime.harness.sessions import DB_SCHEMA
from agent_runtime.migrations.runner import include_name, include_object, target_metadata


def _run_migrations(connection: Connection) -> None:
    connection.execute(text(f"CREATE SCHEMA IF NOT EXISTS {DB_SCHEMA}"))
    context.configure(
        connection=connection,
        target_metadata=target_metadata(),
        version_table_schema=DB_SCHEMA,
        include_schemas=True,
        include_name=include_name,
        include_object=include_object,
    )
    with context.begin_transaction():
        context.run_migrations()


async def _run() -> None:
    engine = create_async_engine(context.config.attributes["sqlalchemy_url"])
    try:
        async with engine.connect() as connection:
            await connection.run_sync(_run_migrations)
            await connection.commit()
    finally:
        await engine.dispose()


if context.is_offline_mode():
    raise RuntimeError("不支持 offline 模式：迁移必须在真实数据库上执行")

asyncio.run(_run())
