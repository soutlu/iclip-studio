from __future__ import annotations

import uuid
from datetime import datetime, timedelta

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.app.conversation_fork import ForkLineageAdapter
from iclip.common.errors import NotFound
from iclip.domains.conversations.infra_sql import SqlConversationRepository
from iclip.domains.identity.models import Principal
from iclip.domains.uploads.infra_sql import SqlUploadRepository
from iclip.domains.uploads.models import MediaKind, MediaUpload
from iclip.domains.uploads.service import UploadService
from tests.helpers.fork_lineage import make_user, open_conversation
from tests.helpers.uploads import FakeBucket


def editor(user_id: uuid.UUID) -> Principal:
    return Principal(
        kind="user",
        user_id=user_id,
        permissions=frozenset({"generation:read", "uploads:write"}),
        audit_label="tester",
    )


async def fetch_nothing(url: str, *, max_bytes: int) -> bytes:
    raise AssertionError("列上传不下载")


async def writable(_principal: Principal, _conversation_id: uuid.UUID) -> None:
    return None


def service_of(engine: AsyncEngine, *, readable: bool = True) -> UploadService:
    async def can_read(_principal: Principal, _conversation_id: uuid.UUID) -> bool:
        return readable

    return UploadService(
        FakeBucket(),
        SqlUploadRepository(engine),
        fetch=fetch_nothing,
        conversation_writable=writable,
        lineage=ForkLineageAdapter(
            conversations=SqlConversationRepository(engine), readable=can_read
        ),
    )


async def planted(
    engine: AsyncEngine,
    owner: uuid.UUID,
    conversation_id: uuid.UUID,
    kind: MediaKind,
    created_at: datetime,
) -> MediaUpload:
    upload = await SqlUploadRepository(engine).insert(
        MediaUpload(
            id=uuid.uuid4(),
            owner_user_id=owner,
            api_key_id=None,
            conversation_id=conversation_id,
            kind=kind,
            url=f"https://cdn.test/iclip/agent/uploads/{uuid.uuid4()}.mp3",
            content_type="audio/mpeg",
            size_bytes=10,
            duration_ms=None,
            width=None,
            height=None,
            content_md5=None,
            created_at=created_at,
        )
    )
    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE iclip.media_uploads SET created_at = :at WHERE id = :id"),
            {"at": created_at, "id": upload.id},
        )
    return upload


async def test_a_fork_sees_the_uploads_its_source_had_when_it_was_forked(
    engine: AsyncEngine,
) -> None:
    conversations = SqlConversationRepository(engine)
    author, forker = await make_user(engine), await make_user(engine)
    source = await open_conversation(conversations, author)
    fork = await open_conversation(conversations, forker, forked_from=source.id)
    forked_at = fork.created_at
    before_fork = await planted(engine, author, source.id, "audio", forked_at - timedelta(hours=1))
    video_before_fork = await planted(
        engine, author, source.id, "video", forked_at - timedelta(minutes=30)
    )
    after_fork = await planted(engine, author, source.id, "audio", forked_at + timedelta(hours=1))
    in_fork = await planted(engine, forker, fork.id, "audio", forked_at + timedelta(hours=2))
    service = service_of(engine)

    audio = await service.conversation_uploads(editor(forker), fork.id, limit=20, kind="audio")
    everything = await service.conversation_uploads(editor(forker), fork.id, limit=20)
    by_address = await service.conversation_uploads_at(
        fork.id, [before_fork.url, after_fork.url, in_fork.url]
    )

    assert [upload.id for upload in audio] == [in_fork.id, before_fork.id]
    assert [upload.id for upload in everything] == [
        in_fork.id,
        video_before_fork.id,
        before_fork.id,
    ]
    assert {url: upload.id for url, upload in by_address.items()} == {
        before_fork.url: before_fork.id,
        in_fork.url: in_fork.id,
    }, "分叉之后源对话才挂上的不算"


async def test_uploads_page_back_from_before(engine: AsyncEngine) -> None:
    owner = await make_user(engine)
    conversation = await open_conversation(SqlConversationRepository(engine), owner)
    start = conversation.created_at
    uploads = [
        await planted(engine, owner, conversation.id, "audio", start + timedelta(minutes=minute))
        for minute in range(3)
    ]
    service = service_of(engine)

    first = await service.conversation_uploads(editor(owner), conversation.id, limit=2)
    rest = await service.conversation_uploads(
        editor(owner), conversation.id, limit=2, before=first[-1].id
    )

    assert [upload.id for upload in first] == [uploads[2].id, uploads[1].id]
    assert [upload.id for upload in rest] == [uploads[0].id]
    with pytest.raises(NotFound):
        await service.conversation_uploads(
            editor(owner), conversation.id, limit=2, before=uuid.uuid4()
        )


async def test_a_conversation_one_cannot_read_has_no_uploads_to_list(engine: AsyncEngine) -> None:
    owner = await make_user(engine)
    conversation = await open_conversation(SqlConversationRepository(engine), owner)
    await planted(engine, owner, conversation.id, "audio", conversation.created_at)

    with pytest.raises(NotFound):
        await service_of(engine, readable=False).conversation_uploads(
            editor(await make_user(engine)), conversation.id, limit=20
        )
