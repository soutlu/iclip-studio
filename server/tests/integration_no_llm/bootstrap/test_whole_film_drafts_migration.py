from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from alembic.config import Config as AlembicConfig
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.domains.conversations.infra_sql import SqlConversationRepository
from iclip.domains.generation.infra_sql import SqlGenerationRepository
from iclip.domains.generation.render import PROVIDER_NAME
from iclip.platform.db.engine import build_engine
from tests.helpers.fork_lineage import make_user, open_conversation
from tests.helpers.generation import make_job, whole_film_request
from tests.helpers.pg import connected, reset_database

SERVER_DIR = Path(__file__).resolve().parents[3]

BASELINE = "aacc58dec9ab"

_INSERT_DRAFT = text(
    "INSERT INTO iclip.whole_film_drafts"
    " (conversation_id, html, revision, updated_by, updated_at)"
    " VALUES (:conversation_id, :html, :revision, :updated_by, now())"
)


async def _owner_and_conversation(engine: AsyncEngine) -> tuple[uuid.UUID, uuid.UUID]:
    owner = await make_user(engine)
    conversation = await open_conversation(SqlConversationRepository(engine), owner)
    return owner, conversation.id


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("overrides", "accepted"),
    [
        ({}, True),
        ({"revision": 0}, False),
        ({"html": None}, False),
        ({"conversation_id": uuid.uuid4()}, False),
        ({"updated_by": uuid.uuid4()}, False),
    ],
    ids=["合规矩", "版本 0", "没有文件", "没有这段对话", "没有这个人"],
)
async def test_the_draft_table_constraints(
    engine: AsyncEngine, overrides: Mapping[str, Any], accepted: bool
) -> None:
    owner, conversation = await _owner_and_conversation(engine)
    row = {
        "conversation_id": conversation,
        "html": "<!doctype html>",
        "revision": 1,
        "updated_by": owner,
        **overrides,
    }
    if accepted:
        async with engine.begin() as conn:
            await conn.execute(_INSERT_DRAFT, row)
        return
    with pytest.raises(IntegrityError):
        async with engine.begin() as conn:
            await conn.execute(_INSERT_DRAFT, row)


async def _plant_before_the_migration(url: str, source: uuid.UUID) -> uuid.UUID:
    """在基线上种一条旧草稿和一条旧形状的成片记录，返回成片记录的 id。"""

    async with connected(url) as conn:
        await reset_database(conn)
    engine = build_engine(url)
    try:
        owner, conversation = await _owner_and_conversation(engine)
        export = await SqlGenerationRepository(engine).create(
            make_job(
                whole_film_request(source),
                owner_user_id=owner,
                conversation_id=conversation,
                provider=PROVIDER_NAME,
            )
        )
        old_keys = {"document": {"layer0": [], "overlays": []}, "subtitles": []}
        async with engine.begin() as conn:
            await conn.execute(
                text(
                    "UPDATE iclip.generation_jobs"
                    " SET request = request || CAST(:old AS jsonb) WHERE id = :id"
                ),
                {"old": json.dumps(old_keys), "id": export.id},
            )
            await conn.execute(
                text(
                    "INSERT INTO iclip.whole_film_drafts"
                    " (conversation_id, document, revision, updated_by, updated_at)"
                    " VALUES (:conversation, '{}'::jsonb, 1, :owner, now())"
                ),
                {"conversation": conversation, "owner": owner},
            )
        return export.id
    finally:
        await engine.dispose()


async def _after_the_migration(url: str, export_id: uuid.UUID) -> tuple[Any, int]:
    engine = build_engine(url)
    try:
        export = await SqlGenerationRepository(engine).get(export_id, owner=None)
        async with engine.connect() as conn:
            drafts = (
                await conn.execute(text("SELECT count(*) FROM iclip.whole_film_drafts"))
            ).scalar_one()
        return export.request, drafts
    finally:
        await engine.dispose()


def test_old_export_records_still_load_and_old_drafts_are_cleared(migrated_pg: str) -> None:
    config = AlembicConfig(str(SERVER_DIR / "alembic.ini"))
    config.set_main_option("script_location", str(SERVER_DIR / "migrations"))
    config.attributes["sqlalchemy_url"] = migrated_pg
    source = uuid.uuid4()

    command.downgrade(config, BASELINE)
    try:
        export_id = asyncio.run(_plant_before_the_migration(migrated_pg, source))
    finally:
        command.upgrade(config, "head")

    request, drafts = asyncio.run(_after_the_migration(migrated_pg, export_id))
    assert request == whole_film_request(source), "请求里只剩版本号和用到的素材，照新形状读得出来"
    assert drafts == 0
