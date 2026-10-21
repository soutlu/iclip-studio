"""删生成记录表 CHECK 约束的迁移：升级后一条约束都不剩、新种类直接落得进去，主键外键照旧；降级
原样加回 12 条；有成片导出的记录时拒绝降级。

升降级在一次性库上做，不动会话共用的测试库。"""

from __future__ import annotations

import asyncio
import uuid
from typing import Any

import pytest
from alembic import command
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.pool import NullPool

from iclip.platform.db.engine import build_engine
from tests.helpers.fork_lineage import make_user
from tests.helpers.migrations import alembic_config

BEFORE = "44c6505380a0"
"""0034，生成记录表还有种类、操作与各种行形状的约束。"""

CHECKS_DROPPED = "b5d1e7a0c934"
"""0035，约束都删了。"""

CHECKS = {
    "ck_generation_jobs_kind",
    "ck_generation_jobs_operation",
    "ck_generation_jobs_request",
    "ck_generation_jobs_video_shape",
    "ck_generation_jobs_image_shape",
    "ck_generation_jobs_cut_shape",
    "ck_generation_jobs_upload_shape",
    "ck_generation_jobs_settled",
    "ck_generation_jobs_content_md5",
    "ck_generation_jobs_subtitle_shape",
    "ck_generation_jobs_sentences",
    "ck_generation_jobs_audio_shape",
}

_CONSTRAINTS = (
    "SELECT conname FROM pg_constraint"
    " WHERE conrelid = 'iclip.generation_jobs'::regclass AND contype::text = :type"
)


async def _constraints(url: str, contype: str) -> set[str]:
    engine = build_engine(url, poolclass=NullPool)
    try:
        async with engine.connect() as conn:
            rows = await conn.execute(text(_CONSTRAINTS), {"type": contype})
            return set(rows.scalars())
    finally:
        await engine.dispose()


async def _whole_film(url: str) -> uuid.UUID:
    """落一条排队中的成片导出记录，返回它的 id。"""

    engine = build_engine(url, poolclass=NullPool)
    try:
        owner = await make_user(engine)
        job_id = uuid.uuid4()
        async with engine.begin() as conn:
            await conn.execute(
                text(
                    "INSERT INTO iclip.generation_jobs"
                    " (id, owner_user_id, conversation_id, kind, operation, provider, request,"
                    "  status, created_at)"
                    " VALUES (:id, :owner, :conversation, 'whole_film', 'render',"
                    "  'whole_film_render', CAST('{}' AS jsonb), 'pending', now())"
                ),
                {"id": job_id, "owner": owner, "conversation": uuid.uuid4()},
            )
        return job_id
    finally:
        await engine.dispose()


async def _scalar(url: str, statement: str) -> Any:
    engine = build_engine(url, poolclass=NullPool)
    try:
        async with engine.connect() as conn:
            return (await conn.execute(text(statement))).scalar()
    finally:
        await engine.dispose()


def test_upgrade_drops_every_check_and_keeps_keys(scratch_db: str) -> None:
    """0034 不收成片导出那种行；升级后 12 条约束都没了，那种行落得进去，主键与两条外键还在。"""

    cfg = alembic_config(scratch_db)
    command.upgrade(cfg, BEFORE)
    assert asyncio.run(_constraints(scratch_db, "c")) == CHECKS
    keys = asyncio.run(_constraints(scratch_db, "p")) | asyncio.run(_constraints(scratch_db, "f"))
    with pytest.raises(IntegrityError):
        asyncio.run(_whole_film(scratch_db))

    command.upgrade(cfg, CHECKS_DROPPED)

    assert asyncio.run(_constraints(scratch_db, "c")) == set()
    after = asyncio.run(_constraints(scratch_db, "p")) | asyncio.run(_constraints(scratch_db, "f"))
    assert after == keys
    asyncio.run(_whole_film(scratch_db))


def test_downgrade_puts_the_checks_back(scratch_db: str) -> None:
    cfg = alembic_config(scratch_db)
    command.upgrade(cfg, CHECKS_DROPPED)

    command.downgrade(cfg, BEFORE)

    assert asyncio.run(_constraints(scratch_db, "c")) == CHECKS
    with pytest.raises(IntegrityError):
        asyncio.run(_whole_film(scratch_db))


def test_downgrade_refuses_while_whole_film_records_exist(scratch_db: str) -> None:
    """有成片导出的记录就拒绝降级，记录与版本原样留着、约束不加回。"""

    cfg = alembic_config(scratch_db)
    command.upgrade(cfg, CHECKS_DROPPED)
    job_id = asyncio.run(_whole_film(scratch_db))

    with pytest.raises(RuntimeError, match="无法无损降级"):
        command.downgrade(cfg, BEFORE)

    kept = asyncio.run(
        _scalar(scratch_db, f"SELECT count(*) FROM iclip.generation_jobs WHERE id = '{job_id}'")
    )
    assert kept == 1
    version = asyncio.run(_scalar(scratch_db, "SELECT version_num FROM iclip.alembic_version"))
    assert version == CHECKS_DROPPED
    assert asyncio.run(_constraints(scratch_db, "c")) == set()
