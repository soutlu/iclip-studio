"""内容结构的默认判断说明迁移：只清空旧默认值，保留自定义说明。"""

from __future__ import annotations

import asyncio
import uuid

from alembic import command
from sqlalchemy import text
from sqlalchemy.pool import NullPool

from iclip.platform.db.engine import build_engine
from tests.helpers.migrations import alembic_config

BEFORE = "7f3c2a9d1e64"
AFTER = "a6e8d20c4f91"


async def _guides(url: str) -> dict[tuple[uuid.UUID | None, str], str | None]:
    engine = build_engine(url, poolclass=NullPool)
    try:
        async with engine.connect() as conn:
            rows = await conn.execute(text("SELECT parent_id, name, guide FROM iclip.library_tags"))
            return {(row.parent_id, row.name): row.guide for row in rows}
    finally:
        await engine.dispose()


async def _customize(url: str, guide: str) -> None:
    engine = build_engine(url, poolclass=NullPool)
    try:
        async with engine.begin() as conn:
            await conn.execute(
                text(
                    "UPDATE iclip.library_tags SET guide = :guide"
                    " WHERE parent_id IS NULL AND name = :name"
                ),
                {"name": "内容结构", "guide": guide},
            )
    finally:
        await engine.dispose()


async def _plant_non_targets(url: str) -> None:
    """同名子标签与其他根维度即使使用旧说明，也不属于本次迁移。"""

    engine = build_engine(url, poolclass=NullPool)
    try:
        async with engine.begin() as conn:
            dimension = (
                await conn.execute(
                    text(
                        "SELECT id, guide FROM iclip.library_tags"
                        " WHERE parent_id IS NULL AND name = :name"
                    ),
                    {"name": "内容结构"},
                )
            ).one()
            await conn.execute(
                text(
                    "INSERT INTO iclip.library_tags (id, parent_id, name, guide, position)"
                    " VALUES (:id, :parent_id, :name, :guide, :position)"
                ),
                [
                    {
                        "id": uuid.uuid4(),
                        "parent_id": dimension.id,
                        "name": "内容结构",
                        "guide": dimension.guide,
                        "position": 100,
                    },
                    {
                        "id": uuid.uuid4(),
                        "parent_id": None,
                        "name": "自定义维度",
                        "guide": dimension.guide,
                        "position": 100,
                    },
                ],
            )
    finally:
        await engine.dispose()


def test_upgrade_clears_only_the_default_content_structure_guide(scratch_db: str) -> None:
    cfg = alembic_config(scratch_db)
    command.upgrade(cfg, BEFORE)
    asyncio.run(_plant_non_targets(scratch_db))
    before = asyncio.run(_guides(scratch_db))

    command.upgrade(cfg, AFTER)

    expected = before | {(None, "内容结构"): ""}
    assert asyncio.run(_guides(scratch_db)) == expected


def test_upgrade_preserves_custom_guide(scratch_db: str) -> None:
    cfg = alembic_config(scratch_db)
    command.upgrade(cfg, BEFORE)
    asyncio.run(_customize(scratch_db, "治理者自定义的判断说明"))
    before = asyncio.run(_guides(scratch_db))

    command.upgrade(cfg, AFTER)

    assert asyncio.run(_guides(scratch_db)) == before
