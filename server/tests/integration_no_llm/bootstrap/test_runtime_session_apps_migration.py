"""会话归属应用的迁移：已有会话回填为 ``video``，之后新行必须写明应用。

升级在一次性库上做，不动会话共用的测试库。"""

from __future__ import annotations

import asyncio
import uuid

import pytest
from alembic import command
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.pool import NullPool

from iclip.platform.db.engine import build_engine
from tests.helpers.migrations import alembic_config

BEFORE = "4d1a8c6e2b90"
"""0043，会话表还没有应用。"""

AFTER = "fd5fe51c6ffc"
"""0044，会话归属应用。"""


async def _execute(url: str, statement: str, params: dict[str, object]) -> None:
    engine = build_engine(url, poolclass=NullPool)
    try:
        async with engine.begin() as conn:
            await conn.execute(text(statement), params)
    finally:
        await engine.dispose()


async def _apps(url: str) -> dict[uuid.UUID, str]:
    engine = build_engine(url, poolclass=NullPool)
    try:
        async with engine.connect() as conn:
            rows = await conn.execute(text("SELECT id, app_id FROM agent_runtime.sessions"))
            return {row.id: row.app_id for row in rows}
    finally:
        await engine.dispose()


def test_upgrade_gives_existing_sessions_to_video_and_requires_an_app_after(
    scratch_db: str,
) -> None:
    cfg = alembic_config(scratch_db)
    command.upgrade(cfg, BEFORE)
    existing = uuid.uuid4()
    asyncio.run(
        _execute(
            scratch_db, "INSERT INTO agent_runtime.sessions (id) VALUES (:id)", {"id": existing}
        )
    )

    command.upgrade(cfg, AFTER)

    assert asyncio.run(_apps(scratch_db)) == {existing: "video"}
    with pytest.raises(IntegrityError):
        asyncio.run(
            _execute(
                scratch_db,
                "INSERT INTO agent_runtime.sessions (id) VALUES (:id)",
                {"id": uuid.uuid4()},
            )
        )
