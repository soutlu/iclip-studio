"""成片草稿现行表的文档、版本和归属约束。"""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.domains.conversations.infra_sql import SqlConversationRepository
from tests.helpers.fork_lineage import make_user, open_conversation

_INSERT_DRAFT = text(
    "INSERT INTO iclip.whole_film_drafts"
    " (conversation_id, document, revision, updated_by, updated_at)"
    " VALUES (:conversation_id, CAST(:document AS jsonb), :revision, :updated_by, now())"
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
