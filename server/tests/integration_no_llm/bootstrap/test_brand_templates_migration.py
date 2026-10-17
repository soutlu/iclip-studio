"""品牌资源迁移：现行表约束、历史升级的数据保留，以及有扩展数据时拒绝降级。

降级在一个临时库上做，不动会话共用的测试库。"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any

import pytest
from alembic import command
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine
from sqlalchemy.pool import NullPool

from iclip.platform.db.engine import build_engine
from tests.helpers.fork_lineage import make_user
from tests.helpers.migrations import alembic_config

BEFORE_BRAND_TEMPLATES = "3c8e5a1f9d40"
"""0027，品牌模板表之前的那一版。"""

BEFORE_URL_RENAME = "476ee9b3b464"
"""0028，地址列仍叫 video_url。"""

URL_RENAMED = "a7d8c31f42e9"
"""0029，只有视频模板，地址列已叫 url。"""

BRAND_RESOURCES = "0f74c2a89d31"
"""0030，kind 为自由文本，brand 与媒体参数独立可空。"""

_INSERT = text(
    "INSERT INTO iclip.brand_templates"
    " (id, kind, brand, name, url, width, height, duration_ms, has_audio, created_by)"
    " VALUES (:id, :kind, :brand, :name, :url, :width, :height, :duration_ms, :has_audio,"
    " :created_by)"
)


def _row(created_by: uuid.UUID) -> dict[str, Any]:
    return {
        "id": uuid.uuid4(),
        "name": "片头",
        "url": "https://cdn.example.test/brand.mp4",
        "width": 1080,
        "height": 1920,
        "duration_ms": 3000,
        "has_audio": True,
        "created_by": created_by,
    }


_NO_VIDEO_PARAMETERS = {"width": None, "height": None, "duration_ms": None, "has_audio": None}


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("overrides", "accepted"),
    [
        ({}, True),
        ({"kind": "outro", "has_audio": False}, True),
        ({"kind": "font", **_NO_VIDEO_PARAMETERS}, True),
        ({"kind": "sound_effect", **_NO_VIDEO_PARAMETERS}, True),
        ({"kind": "sound_effect", "width": None, "height": None, "has_audio": False}, True),
        ({"brand": "品牌 A"}, True),
        ({"kind": None}, False),
        ({"kind": ""}, False),
        ({"kind": " \t\n"}, False),
        ({"duration_ms": 0}, False),
        ({"width": 0}, False),
        ({"height": -1}, False),
        ({"brand": ""}, False),
        ({"brand": "  "}, False),
        ({"brand": " \t\n"}, False),
        ({"name": "  "}, False),
        ({"created_by": uuid.uuid4()}, False),
        *[({field: None}, True) for field in _NO_VIDEO_PARAMETERS],
    ],
)
async def test_the_table_constraints(
    engine: AsyncEngine, overrides: Mapping[str, Any], accepted: bool
) -> None:
    row = {"kind": "intro", "brand": None, **_row(await make_user(engine)), **overrides}
    if accepted:
        async with engine.begin() as conn:
            await conn.execute(_INSERT, row)
        return
    with pytest.raises(IntegrityError):
        async with engine.begin() as conn:
            await conn.execute(_INSERT, row)


async def _has_table(url: str) -> bool:
    engine = build_engine(url, poolclass=NullPool)
    try:
        async with engine.connect() as conn:
            found = await conn.execute(text("SELECT to_regclass('iclip.brand_templates')"))
            return found.scalar() is not None
    finally:
        await engine.dispose()


def test_downgrade_drops_the_table_and_upgrade_brings_it_back(scratch_db: str) -> None:
    cfg = alembic_config(scratch_db)

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
            "position": "intro",
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
    cfg = alembic_config(scratch_db)
    command.upgrade(cfg, BEFORE_URL_RENAME)
    row = asyncio.run(_existing_template(scratch_db))
    previous = {**row, "video_url": row["url"]}
    del previous["url"]

    command.upgrade(cfg, URL_RENAMED)
    assert asyncio.run(_stored_template(scratch_db)) == row
    command.downgrade(cfg, BEFORE_URL_RENAME)
    assert asyncio.run(_stored_template(scratch_db)) == previous
    command.upgrade(cfg, URL_RENAMED)
    assert asyncio.run(_stored_template(scratch_db)) == row


async def _extend_template(url: str, changes: Mapping[str, Any]) -> dict[str, Any]:
    engine = build_engine(url, poolclass=NullPool)
    try:
        async with engine.begin() as conn:
            result = await conn.execute(text("SELECT * FROM iclip.brand_templates"))
            row = {**result.mappings().one(), **changes}
            await conn.execute(
                text(
                    "UPDATE iclip.brand_templates SET kind = :kind, brand = :brand, url = :url,"
                    " width = :width, height = :height, duration_ms = :duration_ms,"
                    " has_audio = :has_audio WHERE id = :id"
                ),
                row,
            )
            return row
    finally:
        await engine.dispose()


def test_resource_upgrade_and_safe_downgrade_preserve_existing_data(scratch_db: str) -> None:
    cfg = alembic_config(scratch_db)
    command.upgrade(cfg, BEFORE_URL_RENAME)
    previous = asyncio.run(_existing_template(scratch_db))
    command.upgrade(cfg, URL_RENAMED)
    assert asyncio.run(_stored_template(scratch_db)) == previous
    expanded = {**previous, "kind": previous["position"], "brand": None}
    del expanded["position"]

    command.upgrade(cfg, BRAND_RESOURCES)
    assert asyncio.run(_stored_template(scratch_db)) == expanded
    command.downgrade(cfg, URL_RENAMED)
    assert asyncio.run(_stored_template(scratch_db)) == previous
    command.upgrade(cfg, BRAND_RESOURCES)
    assert asyncio.run(_stored_template(scratch_db)) == expanded


@pytest.mark.parametrize(
    "changes",
    [
        {"kind": "sound_effect"},
        {"brand": "品牌 A"},
        *[{field: None} for field in _NO_VIDEO_PARAMETERS],
    ],
    ids=["旧版没有的类型", "品牌信息", "缺宽", "缺高", "缺时长", "缺音轨信息"],
)
def test_downgrade_refuses_extended_data_without_losing_it(
    scratch_db: str, changes: Mapping[str, Any]
) -> None:
    cfg = alembic_config(scratch_db)
    command.upgrade(cfg, BEFORE_URL_RENAME)
    asyncio.run(_existing_template(scratch_db))
    command.upgrade(cfg, BRAND_RESOURCES)
    row = asyncio.run(_extend_template(scratch_db, changes))

    with pytest.raises(RuntimeError, match="无法无损降级"):
        command.downgrade(cfg, URL_RENAMED)

    assert asyncio.run(_stored_template(scratch_db)) == row
    command.upgrade(cfg, BRAND_RESOURCES)
    assert asyncio.run(_stored_template(scratch_db)) == row
