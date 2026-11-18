from __future__ import annotations

import asyncio
import uuid
from pathlib import Path
from typing import Any

from alembic import command
from alembic.config import Config as AlembicConfig
from sqlalchemy import text

from iclip.domains.conversations.infra_sql import SqlConversationRepository
from iclip.domains.generation.infra_sql import SqlGenerationRepository
from iclip.domains.generation.render import PROVIDER_NAME
from iclip.platform.db.engine import build_engine
from tests.helpers.fork_lineage import make_user, open_conversation
from tests.helpers.generation import make_job, plant_old_job, whole_film_request
from tests.helpers.pg import connected, reset_database

SERVER_DIR = Path(__file__).resolve().parents[3]

BEFORE_DROPPING_REVISION = "3c1f7a9d2b64"


async def _plant_old_record(url: str, source: uuid.UUID) -> uuid.UUID:
    """在改之前的版本上种一条带 ``revision`` 的成片记录。"""

    engine = build_engine(url)
    try:
        owner = await make_user(engine)
        conversation = (await open_conversation(SqlConversationRepository(engine), owner)).id
        export_id = await plant_old_job(
            engine,
            make_job(
                whole_film_request(source),
                owner_user_id=owner,
                conversation_id=conversation,
                provider=PROVIDER_NAME,
            ),
        )
        async with engine.begin() as conn:
            await conn.execute(
                text(
                    "UPDATE iclip.generation_jobs"
                    " SET request = request || jsonb_build_object('revision', 3) WHERE id = :id"
                ),
                {"id": export_id},
            )
        return export_id
    finally:
        await engine.dispose()


async def _reset(url: str) -> None:
    async with connected(url) as conn:
        await reset_database(conn)


async def _stored_request(url: str, job_id: uuid.UUID) -> dict[str, Any]:
    async with connected(url) as conn:
        row = (
            await conn.execute(
                text("SELECT request FROM iclip.generation_jobs WHERE id = :id"), {"id": job_id}
            )
        ).one()
    return row[0]


async def _request(url: str, job_id: uuid.UUID) -> Any:
    engine = build_engine(url)
    try:
        return (await SqlGenerationRepository(engine).get(job_id, owner=None)).request
    finally:
        await engine.dispose()


def test_old_export_records_lose_the_revision_and_keep_their_sources(migrated_pg: str) -> None:
    config = AlembicConfig(str(SERVER_DIR / "alembic.ini"))
    config.set_main_option("script_location", str(SERVER_DIR / "migrations"))
    config.attributes["sqlalchemy_url"] = migrated_pg
    source = uuid.uuid4()
    asyncio.run(_reset(migrated_pg))

    command.downgrade(config, BEFORE_DROPPING_REVISION)
    try:
        planted = asyncio.run(_plant_old_record(migrated_pg, source))
        assert asyncio.run(_stored_request(migrated_pg, planted))["revision"] == 3
    finally:
        command.upgrade(config, "head")

    stored = asyncio.run(_stored_request(migrated_pg, planted))
    assert "revision" not in stored
    assert stored["videos"] == [
        {"jobId": str(source), "url": f"https://cdn.test/videos/{source}.mp4"}
    ], "videos 原样留着"
    assert asyncio.run(_request(migrated_pg, planted)) == whole_film_request(source), (
        "照新形状读得出来"
    )
