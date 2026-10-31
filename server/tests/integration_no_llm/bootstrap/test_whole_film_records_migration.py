"""删旧成片记录的迁移：只删成片与对它有外键的行，之后视频约束不再收成片那种行。

升级在一次性库上做，不动会话共用的测试库。"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import Mapping
from typing import Any

import pytest
from alembic import command
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.pool import NullPool

from iclip.domains.generation.schemas import (
    KIND_SUBTITLE,
    KIND_VIDEO,
    OPERATION_COMPOSE,
    OPERATION_GENERATE,
)
from iclip.domains.tracking.models import VIDEO_DOWNLOADED
from iclip.platform.db.engine import build_engine
from tests.helpers.fork_lineage import make_user
from tests.helpers.migrations import alembic_config

BEFORE = "529b24b8d9d4"
"""0032，视频约束还收成片。"""

RECORDS_DROPPED = "e82dd7339835"
"""0033，成片记录删掉了。"""

_INSERT_JOB = text(
    "INSERT INTO iclip.generation_jobs"
    " (id, owner_user_id, conversation_id, kind, operation, provider, request, status,"
    "  source_job_id, root_job_id, shot_index, output_url, created_at, finished_at)"
    " VALUES (:id, :owner, :conversation_id, :kind, :operation, 'test',"
    "  CAST(:request AS jsonb), :status, :source, :root, :shot_index, :output_url, now(),"
    "  CASE WHEN :status = 'completed' THEN now() END)"
)

_INSERT_DOWNLOAD = text(
    "INSERT INTO iclip.tracking_events (id, name, job_id, user_id, occurred_at)"
    " VALUES (:id, :name, :job_id, :user_id, now())"
)


def _job(owner: uuid.UUID, conversation_id: uuid.UUID, **fields: Any) -> dict[str, Any]:
    """一条视频行的插入参数；默认是挂着对话、已完成、有地址的出片，各用例改几列。"""

    job_id = fields.pop("id", uuid.uuid4())
    return {
        "id": job_id,
        "owner": owner,
        "conversation_id": conversation_id,
        "kind": KIND_VIDEO,
        "operation": OPERATION_GENERATE,
        "request": json.dumps({"prompt": "海边木栈道"}),
        "status": "completed",
        "source": None,
        "root": None,
        "shot_index": 1,
        "output_url": f"https://cdn.example.test/{job_id}.mp4",
        **fields,
    }


def _whole_film(owner: uuid.UUID, conversation_id: uuid.UUID) -> dict[str, Any]:
    """迁移 0027 收下的那种成片：没有来源、原作与镜号，挂着对话。"""

    return _job(owner, conversation_id, operation=OPERATION_COMPOSE, shot_index=None)


def _subtitle(owner: uuid.UUID, conversation_id: uuid.UUID, source: uuid.UUID) -> dict[str, Any]:
    return _job(
        owner,
        conversation_id,
        kind=KIND_SUBTITLE,
        status="pending",
        source=source,
        shot_index=None,
        output_url=None,
    )


async def _run(url: str, statements: list[tuple[Any, Mapping[str, Any]]]) -> None:
    engine = build_engine(url, poolclass=NullPool)
    try:
        async with engine.begin() as conn:
            for statement, params in statements:
                await conn.execute(statement, params)
    finally:
        await engine.dispose()


async def _rows(url: str, statement: str) -> set[Any]:
    engine = build_engine(url, poolclass=NullPool)
    try:
        async with engine.connect() as conn:
            return set((await conn.execute(text(statement))).scalars())
    finally:
        await engine.dispose()


async def _user(url: str) -> uuid.UUID:
    engine = build_engine(url, poolclass=NullPool)
    try:
        return await make_user(engine)
    finally:
        await engine.dispose()


def test_upgrade_deletes_only_whole_films_and_what_points_at_them(scratch_db: str) -> None:
    """一段对话里有出片、在它上面剪的合成和一条成片，三条各被下载过，成片与出片各有一条字幕记录。
    升级后成片、它的字幕记录与下载事件都没了，出片、合成、出片的字幕记录与它们的下载事件原样留着。"""

    cfg = alembic_config(scratch_db)
    command.upgrade(cfg, BEFORE)
    owner = asyncio.run(_user(scratch_db))
    conversation = uuid.uuid4()
    take = _job(owner, conversation)
    composite = _job(
        owner,
        conversation,
        operation=OPERATION_COMPOSE,
        source=take["id"],
        root=take["id"],
    )
    film = _whole_film(owner, conversation)
    film_subtitle = _subtitle(owner, conversation, film["id"])
    take_subtitle = _subtitle(owner, conversation, take["id"])
    asyncio.run(
        _run(
            scratch_db,
            [
                *((_INSERT_JOB, row) for row in (take, composite, film)),
                *((_INSERT_JOB, row) for row in (film_subtitle, take_subtitle)),
                *(
                    (
                        _INSERT_DOWNLOAD,
                        {
                            "id": uuid.uuid4(),
                            "name": VIDEO_DOWNLOADED,
                            "job_id": row["id"],
                            "user_id": owner,
                        },
                    )
                    for row in (take, composite, film)
                ),
            ],
        )
    )

    command.upgrade(cfg, RECORDS_DROPPED)

    jobs = asyncio.run(_rows(scratch_db, "SELECT id FROM iclip.generation_jobs"))
    downloads = asyncio.run(_rows(scratch_db, "SELECT job_id FROM iclip.tracking_events"))
    assert jobs == {take["id"], composite["id"], take_subtitle["id"]}
    assert downloads == {take["id"], composite["id"]}
    with pytest.raises(IntegrityError):
        asyncio.run(_run(scratch_db, [(_INSERT_JOB, _whole_film(owner, conversation))]))
