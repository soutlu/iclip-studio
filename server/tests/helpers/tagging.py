"""资料库标签的测试替身与种数据：按名字找预置标签、种条目、读条目与它的标签、记下排了哪些打标。

预置的标签树由迁移写入、用例共用；要改树的用例自己加、自己删。"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.domains.tagging.infra_sql import SqlTagStore
from iclip.domains.tagging.service import TaggingService


async def tag_id(engine: AsyncEngine, dimension: str, *path: str) -> uuid.UUID:
    """预置树里按名字一层层往下找：``tag_id(engine, "内容结构", "开箱测评型", "对比测评")``。"""

    async with engine.connect() as conn:
        current = (
            await conn.execute(
                text("SELECT id FROM iclip.library_tags WHERE parent_id IS NULL AND name = :name"),
                {"name": dimension},
            )
        ).scalar_one()
        for name in path:
            current = (
                await conn.execute(
                    text(
                        "SELECT id FROM iclip.library_tags WHERE parent_id = :parent AND name = :name"
                    ),
                    {"parent": current, "name": name},
                )
            ).scalar_one()
    return current


async def plant_entry(
    engine: AsyncEngine,
    reference_id: uuid.UUID,
    *,
    status: str | None = None,
    error: str | None = None,
    tags: Sequence[uuid.UUID] = (),
    started_minutes_ago: float | None = None,
) -> uuid.UUID:
    """给一条参考视频直接种条目与标签；``started_minutes_ago`` 给了就把开始打标时刻放到那么久以前。"""

    entry_id = uuid.uuid4()
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "INSERT INTO iclip.library_entries"
                " (id, kind, reference_id, tag_status, tag_error, tag_started_at)"
                " VALUES (:id, 'reference', :reference_id, :status, :error,"
                " CASE WHEN CAST(:started AS float8) IS NULL THEN NULL"
                "      ELSE now() - make_interval(secs => CAST(:started AS float8) * 60) END)"
            ),
            {
                "id": entry_id,
                "reference_id": reference_id,
                "status": status,
                "error": error,
                "started": started_minutes_ago,
            },
        )
        for one in tags:
            await conn.execute(
                text("INSERT INTO iclip.library_entry_tags (entry_id, tag_id) VALUES (:e, :t)"),
                {"e": entry_id, "t": one},
            )
    return entry_id


async def entry_of(engine: AsyncEngine, reference_id: uuid.UUID) -> dict[str, Any]:
    """一条参考视频的条目，另带 ``tags``（标签 id 的集合）。"""

    async with engine.connect() as conn:
        row = (
            (
                await conn.execute(
                    text(
                        "SELECT * FROM iclip.library_entries"
                        " WHERE kind = 'reference' AND reference_id = :id"
                    ),
                    {"id": reference_id},
                )
            )
            .mappings()
            .one()
        )
        tags = set(
            (
                await conn.execute(
                    text("SELECT tag_id FROM iclip.library_entry_tags WHERE entry_id = :id"),
                    {"id": row["id"]},
                )
            ).scalars()
        )
    return {**dict(row), "tags": tags}


async def add_tag(
    engine: AsyncEngine, parent: uuid.UUID, name: str, *, position: int = 999
) -> uuid.UUID:
    """在预置树里临时加一个标签；用完由用例删掉。"""

    new_id = uuid.uuid4()
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "INSERT INTO iclip.library_tags (id, parent_id, name, position)"
                " VALUES (:id, :parent, :name, :position)"
            ),
            {"id": new_id, "parent": parent, "name": name, "position": position},
        )
    return new_id


async def delete_tag(engine: AsyncEngine, one: uuid.UUID) -> None:
    async with engine.begin() as conn:
        await conn.execute(text("DELETE FROM iclip.library_tags WHERE id = :id"), {"id": one})


class RecordingTaggingQueue:
    """记下排了哪些条目，不执行。"""

    def __init__(self) -> None:
        self.enqueued: list[uuid.UUID] = []

    async def enqueue_tagging(self, entry_id: uuid.UUID) -> None:
        self.enqueued.append(entry_id)


def tagging_service(
    engine: AsyncEngine, queue: RecordingTaggingQueue | None = None
) -> TaggingService:
    """真的 Postgres 仓储，排打标记到 ``queue`` 里；不给就是打标没配置。"""

    return TaggingService(SqlTagStore(engine), queue=queue)


__all__ = [
    "RecordingTaggingQueue",
    "add_tag",
    "delete_tag",
    "entry_of",
    "plant_entry",
    "tag_id",
    "tagging_service",
]
