from __future__ import annotations

import asyncio
import json
import uuid
from pathlib import Path
from typing import Any

from alembic import command
from alembic.config import Config as AlembicConfig
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.domains.conversations.infra_sql import SqlConversationRepository
from iclip.domains.generation.infra_sql import SqlGenerationRepository
from iclip.domains.generation.render import PROVIDER_NAME
from iclip.platform.db.engine import build_engine
from tests.helpers.fork_lineage import make_user, open_conversation
from tests.helpers.generation import make_job, plant_old_job, whole_film_request
from tests.helpers.pg import connected, reset_database

SERVER_DIR = Path(__file__).resolve().parents[3]

BASELINE = "aacc58dec9ab"

BEFORE_DROP = "e257badecd70"


def _alembic(url: str) -> AlembicConfig:
    config = AlembicConfig(str(SERVER_DIR / "alembic.ini"))
    config.set_main_option("script_location", str(SERVER_DIR / "migrations"))
    config.attributes["sqlalchemy_url"] = url
    return config


async def _owner_and_conversation(engine: AsyncEngine) -> tuple[uuid.UUID, uuid.UUID]:
    owner = await make_user(engine)
    conversation = await open_conversation(SqlConversationRepository(engine), owner)
    return owner, conversation.id


async def _reset(url: str) -> None:
    """在最新的表结构上清空数据：旧版本里还有草稿表，它引用着用户表，那时清不了。"""

    async with connected(url) as conn:
        await reset_database(conn)


async def _drafts_table_exists(url: str) -> bool:
    engine = build_engine(url)
    try:
        async with engine.connect() as conn:
            found = await conn.execute(text("SELECT to_regclass('iclip.whole_film_drafts')"))
            return found.scalar_one() is not None
    finally:
        await engine.dispose()


async def _plant_before_the_migration(url: str, source: uuid.UUID) -> uuid.UUID:
    """在基线上种一条旧草稿和一条旧形状的成片记录，返回成片记录的 id。"""

    engine = build_engine(url)
    try:
        owner, conversation = await _owner_and_conversation(engine)
        export_id = await plant_old_job(
            engine,
            make_job(
                whole_film_request(source),
                owner_user_id=owner,
                conversation_id=conversation,
                provider=PROVIDER_NAME,
            ),
        )
        old_keys = {"document": {"layer0": [], "overlays": []}, "subtitles": []}
        async with engine.begin() as conn:
            await conn.execute(
                text(
                    "UPDATE iclip.generation_jobs"
                    " SET request = request || CAST(:old AS jsonb) WHERE id = :id"
                ),
                {"old": json.dumps(old_keys), "id": export_id},
            )
            await conn.execute(
                text(
                    "INSERT INTO iclip.whole_film_drafts"
                    " (conversation_id, document, revision, updated_by, updated_at)"
                    " VALUES (:conversation, '{}'::jsonb, 1, :owner, now())"
                ),
                {"conversation": conversation, "owner": owner},
            )
        return export_id
    finally:
        await engine.dispose()


async def _request_of(url: str, export_id: uuid.UUID) -> Any:
    engine = build_engine(url)
    try:
        return (await SqlGenerationRepository(engine).get(export_id, owner=None)).request
    finally:
        await engine.dispose()


def test_old_export_records_still_load_and_the_draft_table_is_gone(migrated_pg: str) -> None:
    config = _alembic(migrated_pg)
    source = uuid.uuid4()
    asyncio.run(_reset(migrated_pg))

    command.downgrade(config, BASELINE)
    try:
        export_id = asyncio.run(_plant_before_the_migration(migrated_pg, source))
    finally:
        command.upgrade(config, "head")

    assert asyncio.run(_request_of(migrated_pg, export_id)) == whole_film_request(source), (
        "请求里只剩版本号和用到的素材，照新形状读得出来"
    )
    assert not asyncio.run(_drafts_table_exists(migrated_pg)), "草稿表连同旧草稿一起删掉"


async def _plant_draft(url: str) -> None:
    engine = build_engine(url)
    try:
        owner, conversation = await _owner_and_conversation(engine)
        async with engine.begin() as conn:
            await conn.execute(
                text(
                    "INSERT INTO iclip.whole_film_drafts"
                    " (conversation_id, html, revision, updated_by, updated_at)"
                    " VALUES (:conversation, '<!doctype html>', 1, :owner, now())"
                ),
                {"conversation": conversation, "owner": owner},
            )
    finally:
        await engine.dispose()


def test_the_draft_table_is_dropped_and_a_downgrade_brings_back_an_empty_one(
    migrated_pg: str,
) -> None:
    config = _alembic(migrated_pg)
    assert not asyncio.run(_drafts_table_exists(migrated_pg))

    command.downgrade(config, BEFORE_DROP)
    try:
        assert asyncio.run(_drafts_table_exists(migrated_pg))
        asyncio.run(_plant_draft(migrated_pg))
    finally:
        command.upgrade(config, "head")

    assert not asyncio.run(_drafts_table_exists(migrated_pg))
