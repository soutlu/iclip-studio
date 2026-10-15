"""品牌模板迁移：现行表的约束、0028 建表与 0029 地址列改名的数据保留。

降级在一个临时库上做，不动会话共用的测试库。"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Generator, Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from alembic.config import Config as AlembicConfig
from sqlalchemy import make_url, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine
from sqlalchemy.pool import NullPool

from iclip.platform.db.engine import build_engine
from tests.helpers.fork_lineage import make_user

BEFORE_BRAND_TEMPLATES = "3c8e5a1f9d40"
"""0027，品牌模板表之前的那一版。"""

BEFORE_URL_RENAME = "476ee9b3b464"
"""0028，地址列仍叫 video_url。"""

_INSERT = text(
    "INSERT INTO iclip.brand_templates"
    " (id, position, name, url, width, height, duration_ms, has_audio, created_by)"
    " VALUES (:id, :position, :name, :url, :width, :height, :duration_ms, :has_audio,"
    " :created_by)"
)


def _row(created_by: uuid.UUID) -> dict[str, Any]:
    return {
        "id": uuid.uuid4(),
        "position": "intro",
        "name": "片头",
        "url": "https://cdn.example.test/brand.mp4",
        "width": 1080,
        "height": 1920,
        "duration_ms": 3000,
        "has_audio": True,
        "created_by": created_by,
    }


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("overrides", "accepted"),
    [
        ({}, True),
        ({"position": "outro"}, True),
        ({"position": "middle"}, False),
        ({"duration_ms": 0}, False),
        ({"width": 0}, False),
        ({"height": -1}, False),
        ({"name": "  "}, False),
        ({"created_by": uuid.uuid4()}, False),
    ],
    ids=["片头", "片尾", "位置取值外", "时长为 0", "宽为 0", "高为负", "名称空白", "创建人不存在"],
)
async def test_the_table_constraints(
    engine: AsyncEngine, overrides: Mapping[str, Any], accepted: bool
) -> None:
    row = {**_row(await make_user(engine)), **overrides}
    if accepted:
        async with engine.begin() as conn:
            await conn.execute(_INSERT, row)
        return
    with pytest.raises(IntegrityError):
        async with engine.begin() as conn:
            await conn.execute(_INSERT, row)


def _alembic(url: str) -> AlembicConfig:
    server_dir = Path(__file__).resolve().parents[3]
    cfg = AlembicConfig(str(server_dir / "alembic.ini"))
    cfg.set_main_option("script_location", str(server_dir / "migrations"))
    cfg.attributes["sqlalchemy_url"] = url
    return cfg


async def _admin(url: str, statement: str) -> None:
    """CREATE / DROP DATABASE 不能在事务里跑，走自动提交。"""

    engine = build_engine(url, poolclass=NullPool, isolation_level="AUTOCOMMIT")
    try:
        async with engine.connect() as conn:
            await conn.execute(text(statement))
    finally:
        await engine.dispose()


async def _has_table(url: str) -> bool:
    engine = build_engine(url, poolclass=NullPool)
    try:
        async with engine.connect() as conn:
            found = await conn.execute(text("SELECT to_regclass('iclip.brand_templates')"))
            return found.scalar() is not None
    finally:
        await engine.dispose()


@pytest.fixture
def scratch_db(pg_url: str) -> Generator[str]:
    """同一台 Postgres 上的一个一次性库，用完删掉。"""

    name = f"migration_{uuid.uuid4().hex[:12]}"
    asyncio.run(_admin(pg_url, f'CREATE DATABASE "{name}"'))
    try:
        yield make_url(pg_url).set(database=name).render_as_string(hide_password=False)
    finally:
        asyncio.run(_admin(pg_url, f'DROP DATABASE "{name}" WITH (FORCE)'))


def test_downgrade_drops_the_table_and_upgrade_brings_it_back(scratch_db: str) -> None:
    cfg = _alembic(scratch_db)

    command.upgrade(cfg, "head")
    assert asyncio.run(_has_table(scratch_db))
    command.downgrade(cfg, BEFORE_BRAND_TEMPLATES)
    assert not asyncio.run(_has_table(scratch_db))
    command.upgrade(cfg, "head")
    assert asyncio.run(_has_table(scratch_db))


async def _existing_template(url: str) -> dict[str, Any]:
    """在 0028 表里写一条每列都有值的模板，返回改名后应保留的完整数据。"""

    engine = build_engine(url, poolclass=NullPool)
    try:
        row = {
            **_row(await make_user(engine)),
            "api_key_id": uuid.uuid4(),
            "created_at": datetime(2026, 10, 14, 10, 0, tzinfo=UTC),
            "disabled_at": datetime(2026, 10, 14, 11, 0, tzinfo=UTC),
        }
        async with engine.begin() as conn:
            await conn.execute(
                text(
                    "INSERT INTO iclip.brand_templates"
                    " (id, position, name, video_url, width, height, duration_ms, has_audio,"
                    " created_by, api_key_id, created_at, disabled_at)"
                    " VALUES (:id, :position, :name, :url, :width, :height, :duration_ms,"
                    " :has_audio, :created_by, :api_key_id, :created_at, :disabled_at)"
                ),
                row,
            )
        return row
    finally:
        await engine.dispose()


async def _stored_template(url: str) -> dict[str, Any]:
    engine = build_engine(url, poolclass=NullPool)
    try:
        async with engine.connect() as conn:
            result = await conn.execute(text("SELECT * FROM iclip.brand_templates"))
            return dict(result.mappings().one())
    finally:
        await engine.dispose()


def test_url_rename_preserves_existing_data_in_both_directions(scratch_db: str) -> None:
    cfg = _alembic(scratch_db)
    command.upgrade(cfg, BEFORE_URL_RENAME)
    row = asyncio.run(_existing_template(scratch_db))
    previous = {**row, "video_url": row["url"]}
    del previous["url"]

    command.upgrade(cfg, "head")
    assert asyncio.run(_stored_template(scratch_db)) == row
    command.downgrade(cfg, BEFORE_URL_RENAME)
    assert asyncio.run(_stored_template(scratch_db)) == previous
    command.upgrade(cfg, "head")
    assert asyncio.run(_stored_template(scratch_db)) == row
