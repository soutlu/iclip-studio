from __future__ import annotations

import asyncio
import uuid
from collections.abc import Sequence
from typing import Any

from alembic import command
from sqlalchemy import text
from sqlalchemy.pool import NullPool

from iclip.platform.db.engine import build_engine
from tests.helpers.fork_lineage import make_user
from tests.helpers.migrations import alembic_config

BEFORE = "b5d1e7a0c934"

AFTER = "7f3c2a9d1e64"


async def _plant(
    url: str, rows: Sequence[tuple[str | None, Sequence[str], Sequence[str], bool]]
) -> list[uuid.UUID]:
    engine = build_engine(url, poolclass=NullPool)
    try:
        owner = await make_user(engine)
        planted: list[uuid.UUID] = []
        async with engine.begin() as conn:
            for index, (document, types, categories, removed) in enumerate(rows):
                reference_id = uuid.uuid4()
                await conn.execute(
                    text(
                        "INSERT INTO iclip.reference_videos (id, video_url, owner_user_id,"
                        " video_types, categories, breakdown_status, document, deleted_at)"
                        " VALUES (:id, :url, :owner, CAST(:types AS text[]),"
                        " CAST(:categories AS text[]), 'completed', :document,"
                        " CASE WHEN CAST(:removed AS boolean) THEN now() END)"
                    ),
                    {
                        "id": reference_id,
                        "url": f"https://cdn.example.test/{index}.mp4",
                        "owner": owner,
                        "types": list(types),
                        "categories": list(categories),
                        "document": document,
                        "removed": removed,
                    },
                )
                planted.append(reference_id)
        return planted
    finally:
        await engine.dispose()


async def _entries(url: str) -> dict[uuid.UUID, dict[str, Any]]:
    engine = build_engine(url, poolclass=NullPool)
    try:
        async with engine.connect() as conn:
            rows = (
                await conn.execute(
                    text(
                        "SELECT e.reference_id, e.kind, e.tag_status, e.created_by,"
                        " r.owner_user_id, p.name AS parent, t.name"
                        " FROM iclip.library_entries e"
                        " JOIN iclip.reference_videos r ON r.id = e.reference_id"
                        " LEFT JOIN iclip.library_entry_tags et ON et.entry_id = e.id"
                        " LEFT JOIN iclip.library_tags t ON t.id = et.tag_id"
                        " LEFT JOIN iclip.library_tags p ON p.id = t.parent_id"
                    )
                )
            ).mappings()
            found: dict[uuid.UUID, dict[str, Any]] = {}
            for row in rows:
                entry = found.setdefault(
                    row["reference_id"],
                    {
                        "kind": row["kind"],
                        "status": row["tag_status"],
                        "by_owner": row["created_by"] == row["owner_user_id"],
                        "tags": set(),
                    },
                )
                if row["name"] is not None:
                    entry["tags"].add(f"{row['parent']}/{row['name']}")
            return found
    finally:
        await engine.dispose()


async def _columns(url: str) -> set[str]:
    engine = build_engine(url, poolclass=NullPool)
    try:
        async with engine.connect() as conn:
            rows = await conn.execute(
                text(
                    "SELECT column_name FROM information_schema.columns"
                    " WHERE table_schema = 'iclip' AND table_name = 'reference_videos'"
                )
            )
            return set(rows.scalars())
    finally:
        await engine.dispose()


def test_upgrade_moves_old_tags_into_entries(scratch_db: str) -> None:
    cfg = alembic_config(scratch_db)
    command.upgrade(cfg, BEFORE)
    tagged, untouched, removed = asyncio.run(
        _plant(
            scratch_db,
            [
                ("# 拆解", ("try_on", "lifestyle", "review"), ("跑鞋", "袜子"), False),
                (None, ("drama",), (), False),
                ("# 拆解", ("live_clip", "slideshow"), ("拖鞋",), True),
            ],
        )
    )

    command.upgrade(cfg, AFTER)

    entries = asyncio.run(_entries(scratch_db))
    assert entries[tagged] == {
        "kind": "reference",
        "status": "completed",
        "by_owner": True,
        "tags": {"内容结构/真人种草型", "内容结构/开箱测评型", "品类/跑鞋", "品类/袜子"},
    }
    assert (entries[untouched]["status"], entries[untouched]["tags"]) == (
        None,
        {"内容结构/剧情叙事型"},
    )
    assert entries[removed]["tags"] == {
        "内容结构/直播切片优化型",
        "内容结构/素材混剪型",
        "品类/拖鞋",
    }
    assert not {"video_types", "categories"} & asyncio.run(_columns(scratch_db))
