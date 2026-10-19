"""整片草稿表与音乐上传挂对话的迁移：草稿表的约束、升降级往返，以及有挂了对话的音乐上传时拒绝降级。

降级在一次性库上做，不动会话共用的测试库。"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Mapping
from typing import Any

import pytest
from alembic import command
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine
from sqlalchemy.pool import NullPool

from iclip.domains.conversations.infra_sql import SqlConversationRepository
from iclip.platform.db.engine import build_engine
from tests.helpers.fork_lineage import make_user, open_conversation
from tests.helpers.migrations import alembic_config

BEFORE_DRAFTS = "0f74c2a89d31"
"""0030，整片草稿表之前的那一版。"""

DRAFTS = "a38f28430ec1"
"""0031，有整片草稿表，上传还都不挂对话。"""

AUDIO_UPLOADS_ATTACHED = "529b24b8d9d4"
"""0032，音乐上传可以挂对话。"""

_INSERT_DRAFT = text(
    "INSERT INTO iclip.whole_film_drafts"
    " (conversation_id, document, revision, updated_by, updated_at)"
    " VALUES (:conversation_id, CAST(:document AS jsonb), :revision, :updated_by, now())"
)

_INSERT_UPLOAD = text(
    "INSERT INTO iclip.generation_jobs"
    " (id, owner_user_id, conversation_id, kind, operation, provider, status, output_url,"
    "  created_at, finished_at)"
    " VALUES (:id, :owner, :conversation_id, :kind, 'upload', 'upload', 'completed',"
    "  'https://cdn.example.test/upload', now(), now())"
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
        ({"document": "[]"}, False),
        ({"document": "null"}, False),
        ({"conversation_id": uuid.uuid4()}, False),
        ({"updated_by": uuid.uuid4()}, False),
    ],
    ids=["合规矩", "版本 0", "文档是数组", "文档是 null", "没有这段对话", "没有这个人"],
)
async def test_the_draft_table_constraints(
    engine: AsyncEngine, overrides: Mapping[str, Any], accepted: bool
) -> None:
    owner, conversation = await _owner_and_conversation(engine)
    row = {
        "conversation_id": conversation,
        "document": "{}",
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


async def _query(url: str, statement: str) -> Any:
    engine = build_engine(url, poolclass=NullPool)
    try:
        async with engine.connect() as conn:
            return (await conn.execute(text(statement))).scalar()
    finally:
        await engine.dispose()


async def _attached_music_upload(url: str) -> uuid.UUID:
    """在 ``url`` 那个库里落一条挂了对话的音乐上传，返回它的 id。"""

    engine = build_engine(url, poolclass=NullPool)
    try:
        owner, conversation = await _owner_and_conversation(engine)
        upload_id = uuid.uuid4()
        async with engine.begin() as conn:
            await conn.execute(
                _INSERT_UPLOAD,
                {"id": upload_id, "owner": owner, "conversation_id": conversation, "kind": "audio"},
            )
        return upload_id
    finally:
        await engine.dispose()


def test_downgrade_drops_the_table_and_restores_the_upload_rule(scratch_db: str) -> None:
    cfg = alembic_config(scratch_db)

    command.upgrade(cfg, "head")
    assert asyncio.run(_query(scratch_db, "SELECT to_regclass('iclip.whole_film_drafts')"))
    command.downgrade(cfg, BEFORE_DRAFTS)
    assert asyncio.run(_query(scratch_db, "SELECT to_regclass('iclip.whole_film_drafts')")) is None
    with pytest.raises(IntegrityError):
        asyncio.run(_attached_music_upload(scratch_db))
    command.upgrade(cfg, "head")
    assert asyncio.run(_query(scratch_db, "SELECT to_regclass('iclip.whole_film_drafts')"))


def test_downgrade_refuses_music_uploads_attached_to_a_conversation(scratch_db: str) -> None:
    """有挂了对话的音乐上传时拒绝降级，那条记录与它挂的对话原样留着。"""

    cfg = alembic_config(scratch_db)
    command.upgrade(cfg, AUDIO_UPLOADS_ATTACHED)
    upload_id = asyncio.run(_attached_music_upload(scratch_db))

    with pytest.raises(RuntimeError, match="无法无损降级"):
        command.downgrade(cfg, DRAFTS)

    attached = asyncio.run(
        _query(
            scratch_db,
            f"SELECT conversation_id IS NOT NULL FROM iclip.generation_jobs WHERE id = '{upload_id}'",
        )
    )
    assert attached is True
    version = asyncio.run(_query(scratch_db, "SELECT version_num FROM iclip.alembic_version"))
    assert version == AUDIO_UPLOADS_ATTACHED
