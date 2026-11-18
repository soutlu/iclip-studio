from __future__ import annotations

import uuid
from collections.abc import Collection, Mapping
from typing import Any, Final

from sqlalchemy import (
    BigInteger,
    Column,
    ColumnElement,
    DateTime,
    Index,
    Integer,
    MetaData,
    Table,
    Text,
    Uuid,
    and_,
    exists,
    func,
    or_,
    select,
    text,
    tuple_,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.engine.row import RowMapping
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.domains.uploads.models import Inheritance, MediaKind, MediaUpload

DB_SCHEMA: Final = "iclip"

metadata_obj = MetaData(schema=DB_SCHEMA)

# 表上不设外键与取值约束：种类等业务取值只在应用层校验（models.UPLOAD_TYPES）。
media_uploads_table = Table(
    "media_uploads",
    metadata_obj,
    Column("id", Uuid, primary_key=True),
    Column("owner_user_id", Uuid, nullable=False),
    Column("api_key_id", Uuid, nullable=True),
    Column("conversation_id", Uuid, nullable=True),
    Column("kind", Text, nullable=False),
    Column("url", Text, nullable=False),
    Column("content_type", Text, nullable=True),
    Column("size_bytes", BigInteger, nullable=True),
    Column("duration_ms", Integer, nullable=True),
    Column("width", Integer, nullable=True),
    Column("height", Integer, nullable=True),
    Column("content_md5", Text, nullable=True),
    Column("meta", JSONB, nullable=False, server_default=text("'{}'::jsonb")),
    Column("created_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
    Index(
        "ix_media_uploads_dedup",
        "kind",
        "content_md5",
        "created_at",
        "id",
        postgresql_where=text("content_md5 IS NOT NULL"),
    ),
    Index("ix_media_uploads_owner", "owner_user_id", "kind", text("created_at DESC"), "id"),
    Index(
        "ix_media_uploads_conversation",
        "conversation_id",
        "kind",
        text("created_at DESC"),
        "id",
        postgresql_where=text("conversation_id IS NOT NULL"),
    ),
    Index("ix_media_uploads_url", "url", postgresql_using="hash"),
)

_UPLOADS = media_uploads_table.c


class SqlUploadRepository:
    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def insert(self, upload: MediaUpload) -> MediaUpload:
        stmt = (
            pg_insert(media_uploads_table)
            .values(
                id=upload.id,
                owner_user_id=upload.owner_user_id,
                api_key_id=upload.api_key_id,
                conversation_id=upload.conversation_id,
                kind=upload.kind,
                url=upload.url,
                content_type=upload.content_type,
                size_bytes=upload.size_bytes,
                duration_ms=upload.duration_ms,
                width=upload.width,
                height=upload.height,
                content_md5=upload.content_md5,
                created_at=func.now(),
            )
            .on_conflict_do_nothing(index_elements=[_UPLOADS.id])
            .returning(media_uploads_table)
        )
        async with self._engine.begin() as conn:
            row = (await conn.execute(stmt)).mappings().one_or_none()
        if row is not None:
            return _upload_from_row(row)
        existing = await self.get(upload.id)
        if existing is None:
            raise RuntimeError(f"上传 {upload.id} 撞了主键却读不到已有的那条")
        return existing

    async def get(self, upload_id: uuid.UUID) -> MediaUpload | None:
        return await self._one(select(media_uploads_table).where(_UPLOADS.id == upload_id))

    async def earliest_video_with_md5(self, content_md5: str) -> MediaUpload | None:
        return await self._one(
            select(media_uploads_table)
            .where(_UPLOADS.kind == "video", _UPLOADS.content_md5 == content_md5)
            .order_by(_UPLOADS.created_at, _UPLOADS.id)
            .limit(1)
        )

    async def owned_video_at(self, owner: uuid.UUID, url: str) -> bool:
        stmt = select(
            exists().where(
                _UPLOADS.url == url, _UPLOADS.kind == "video", _UPLOADS.owner_user_id == owner
            )
        )
        async with self._engine.connect() as conn:
            return bool((await conn.execute(stmt)).scalar_one())

    async def list_in_conversation(
        self,
        conversation_id: uuid.UUID,
        *,
        limit: int,
        kind: MediaKind | None = None,
        before: MediaUpload | None = None,
        inherited: Inheritance = (),
    ) -> tuple[MediaUpload, ...]:
        stmt = select(media_uploads_table).where(_in_conversation(conversation_id, inherited))
        if kind is not None:
            stmt = stmt.where(_UPLOADS.kind == kind)
        if before is not None:
            stmt = stmt.where(
                tuple_(_UPLOADS.created_at, _UPLOADS.id) < (before.created_at, before.id)
            )
        stmt = stmt.order_by(_UPLOADS.created_at.desc(), _UPLOADS.id.desc()).limit(limit)
        async with self._engine.connect() as conn:
            rows = (await conn.execute(stmt)).mappings().all()
        return tuple(_upload_from_row(row) for row in rows)

    async def earliest_in_conversation(
        self, conversation_id: uuid.UUID, urls: Collection[str], *, inherited: Inheritance = ()
    ) -> Mapping[str, MediaUpload]:
        if not urls:
            return {}
        stmt = (
            select(media_uploads_table)
            .where(_UPLOADS.url.in_(list(urls)), _in_conversation(conversation_id, inherited))
            .distinct(_UPLOADS.url)
            .order_by(_UPLOADS.url, _UPLOADS.created_at, _UPLOADS.id)
        )
        async with self._engine.connect() as conn:
            rows = (await conn.execute(stmt)).mappings().all()
        return {row["url"]: _upload_from_row(row) for row in rows}

    async def _one(self, stmt: Any) -> MediaUpload | None:
        async with self._engine.connect() as conn:
            row = (await conn.execute(stmt)).mappings().one_or_none()
        return None if row is None else _upload_from_row(row)


def _in_conversation(conversation_id: uuid.UUID, inherited: Inheritance) -> ColumnElement[bool]:
    return or_(
        _UPLOADS.conversation_id == conversation_id,
        *(
            and_(_UPLOADS.conversation_id == ancestor, _UPLOADS.created_at <= boundary)
            for ancestor, boundary in inherited
        ),
    )


def _upload_from_row(row: RowMapping) -> MediaUpload:
    return MediaUpload(
        id=row["id"],
        owner_user_id=row["owner_user_id"],
        api_key_id=row["api_key_id"],
        conversation_id=row["conversation_id"],
        kind=row["kind"],
        url=row["url"],
        content_type=row["content_type"],
        size_bytes=row["size_bytes"],
        duration_ms=row["duration_ms"],
        width=row["width"],
        height=row["height"],
        content_md5=row["content_md5"],
        created_at=row["created_at"],
    )


__all__ = ["DB_SCHEMA", "SqlUploadRepository", "media_uploads_table", "metadata_obj"]
