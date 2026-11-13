from __future__ import annotations

import asyncio
import json
import uuid
from pathlib import Path
from typing import Any

from alembic import command
from alembic.config import Config as AlembicConfig
from sqlalchemy import text

from iclip.domains.conversations.infra_sql import SqlConversationRepository
from iclip.domains.generation.infra_sql import SqlGenerationRepository
from iclip.domains.generation.render import PROVIDER_NAME
from iclip.domains.generation.schemas import WholeFilmAudioSource, WholeFilmRequest
from iclip.platform.db.engine import build_engine
from tests.helpers.fork_lineage import make_user, open_conversation
from tests.helpers.generation import make_job, whole_film_request
from tests.helpers.pg import connected, reset_database

SERVER_DIR = Path(__file__).resolve().parents[3]

BEFORE_AUDIOS = "9f3796a31ae4"

MUSIC = {"jobId": str(uuid.uuid4()), "url": "https://cdn.test/iclip/agent/audio/music.wav"}


async def _plant_old_records(url: str, source: uuid.UUID) -> tuple[uuid.UUID, uuid.UUID]:
    """在改之前的版本上种两条旧形状的成片记录：一条 ``music`` 是 null，一条带一条配乐。"""

    async with connected(url) as conn:
        await reset_database(conn)
    engine = build_engine(url)
    try:
        owner = await make_user(engine)
        conversation = (await open_conversation(SqlConversationRepository(engine), owner)).id
        repo = SqlGenerationRepository(engine)
        planted: list[uuid.UUID] = []
        for music in (None, MUSIC):
            export = await repo.create(
                make_job(
                    whole_film_request(source),
                    owner_user_id=owner,
                    conversation_id=conversation,
                    provider=PROVIDER_NAME,
                )
            )
            async with engine.begin() as conn:
                await conn.execute(
                    text(
                        "UPDATE iclip.generation_jobs SET request = (request - 'audios')"
                        " || jsonb_build_object('music', CAST(:music AS jsonb)) WHERE id = :id"
                    ),
                    {"music": json.dumps(music), "id": export.id},
                )
            planted.append(export.id)
        return planted[0], planted[1]
    finally:
        await engine.dispose()


async def _requests(url: str, *ids: uuid.UUID) -> list[Any]:
    engine = build_engine(url)
    try:
        repo = SqlGenerationRepository(engine)
        return [(await repo.get(job_id, owner=None)).request for job_id in ids]
    finally:
        await engine.dispose()


def test_old_export_records_get_an_audio_list_in_place_of_music(migrated_pg: str) -> None:
    config = AlembicConfig(str(SERVER_DIR / "alembic.ini"))
    config.set_main_option("script_location", str(SERVER_DIR / "migrations"))
    config.attributes["sqlalchemy_url"] = migrated_pg
    source = uuid.uuid4()

    command.downgrade(config, BEFORE_AUDIOS)
    try:
        without_music, with_music = asyncio.run(_plant_old_records(migrated_pg, source))
    finally:
        command.upgrade(config, "head")

    assert asyncio.run(_requests(migrated_pg, without_music, with_music)) == [
        whole_film_request(source),
        WholeFilmRequest(
            revision=1,
            videos=whole_film_request(source).videos,
            audios=[
                WholeFilmAudioSource(job_id=uuid.UUID(MUSIC["jobId"]), url=MUSIC["url"]),
            ],
        ),
    ], "music 是 null 的换成空列表，带配乐的换成只有它的列表，照新形状读得出来"
