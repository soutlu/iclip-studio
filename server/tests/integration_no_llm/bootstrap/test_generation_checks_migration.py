from __future__ import annotations

import asyncio
import uuid

import pytest
from alembic import command
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.pool import NullPool

from iclip.platform.db.engine import build_engine
from tests.helpers.fork_lineage import make_user
from tests.helpers.migrations import alembic_config

BEFORE = "44c6505380a0"

CHECKS_DROPPED = "b5d1e7a0c934"

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


def test_upgrade_drops_every_check_and_keeps_keys(scratch_db: str) -> None:
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
