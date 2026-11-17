from __future__ import annotations

import asyncio
import uuid
from pathlib import Path

from alembic import command
from alembic.config import Config as AlembicConfig
from sqlalchemy import text

from iclip.platform.db.engine import build_engine
from tests.helpers.fork_lineage import make_user
from tests.helpers.pg import connected, reset_database

SERVER_DIR = Path(__file__).resolve().parents[3]

BEFORE_DROP = "7d2a4c9e1f38"


def _alembic(url: str) -> AlembicConfig:
    config = AlembicConfig(str(SERVER_DIR / "alembic.ini"))
    config.set_main_option("script_location", str(SERVER_DIR / "migrations"))
    config.attributes["sqlalchemy_url"] = url
    return config


async def _reset(url: str) -> None:
    async with connected(url) as conn:
        await reset_database(conn)


async def _tables_present(url: str) -> tuple[bool, bool]:
    engine = build_engine(url)
    try:
        async with engine.connect() as conn:
            templates = (
                await conn.execute(text("SELECT to_regclass('iclip.brand_templates')"))
            ).scalar_one()
            profiles = (
                await conn.execute(text("SELECT to_regclass('iclip.brand_profiles')"))
            ).scalar_one()
            return templates is not None, profiles is not None
    finally:
        await engine.dispose()


async def _plant_legacy_rows(url: str) -> None:
    engine = build_engine(url)
    try:
        owner = await make_user(engine)
        async with engine.begin() as conn:
            await conn.execute(
                text(
                    "INSERT INTO iclip.brand_profiles (brand, slogan, accent_color, updated_by, updated_at)"
                    " VALUES ('BRAND_A', 'slogan', '#112233', :owner, now())"
                ),
                {"owner": owner},
            )
            await conn.execute(
                text(
                    "INSERT INTO iclip.brand_templates (id, kind, brand, name, url, created_by)"
                    " VALUES (:id, 'font', 'BRAND_A', '品牌字体', 'https://cdn.test/font.ttf', :owner)"
                ),
                {"id": uuid.uuid4(), "owner": owner},
            )
    finally:
        await engine.dispose()


def test_brand_tables_are_dropped_and_downgrade_restores_empty_tables(migrated_pg: str) -> None:
    config = _alembic(migrated_pg)
    asyncio.run(_reset(migrated_pg))
    assert asyncio.run(_tables_present(migrated_pg)) == (False, False)

    command.downgrade(config, BEFORE_DROP)
    try:
        assert asyncio.run(_tables_present(migrated_pg)) == (True, True)
        asyncio.run(_plant_legacy_rows(migrated_pg))
    finally:
        command.upgrade(config, "head")

    assert asyncio.run(_tables_present(migrated_pg)) == (False, False)
