from __future__ import annotations

import uuid
from collections.abc import Collection, Mapping
from dataclasses import replace
from datetime import UTC, datetime, timedelta

from iclip.domains.uploads.models import Inheritance, MediaKind, MediaUpload
from iclip.platform.object_store.store import ObjectStoreUnavailable, StoredObject


class FakeBucket:
    def __init__(self, *, base: str = "https://cdn.test") -> None:
        self.base = base
        self.objects: dict[str, StoredObject] = {}
        self.signed: list[tuple[str, dict[str, str]]] = []
        self.written: dict[str, tuple[bytes, dict[str, str]]] = {}
        self.delete_fails = False
        self.put_fails = False

    async def put_public_object(
        self,
        *,
        object_key: str,
        content: bytes,
        content_type: str,
        metadata: Mapping[str, str] | None = None,
    ) -> str:
        if self.put_fails:
            raise ObjectStoreUnavailable("OSS 写入失败（试了 3 次）: Read timed out")
        self.put(object_key, content_type=content_type, size_bytes=len(content))
        self.written[object_key] = (content, dict(metadata or {}))
        return self.public_url(object_key)

    def put(
        self,
        object_key: str,
        *,
        content_type: str,
        size_bytes: int = 1024,
        etag: str | None = None,
        object_type: str | None = "Normal",
    ) -> None:
        self.objects[object_key] = StoredObject(
            object_key=object_key,
            content_type=content_type,
            size_bytes=size_bytes,
            etag=etag,
            object_type=object_type,
        )

    def sign_put(self, *, object_key: str, headers: Mapping[str, str]) -> str:
        self.signed.append((object_key, dict(headers)))
        return f"{self.base}/{object_key}?signed"

    async def find_object(self, *, prefix: str) -> StoredObject | None:
        for key, stored in self.objects.items():
            if key.startswith(prefix):
                return stored
        return None

    async def delete_object(self, object_key: str) -> None:
        if self.delete_fails:
            raise ObjectStoreUnavailable("OSS 删除失败: 403 AccessDenied")
        self.objects.pop(object_key, None)

    def public_url(self, object_key: str) -> str:
        return f"{self.base}/{object_key}"


class InMemoryUploadRepository:
    """上传台账的替身：按 id 存，记下的时间依次往后。按对话列、按地址对在集成测试里覆盖。"""

    def __init__(self) -> None:
        self.rows: dict[uuid.UUID, MediaUpload] = {}

    async def insert(self, upload: MediaUpload) -> MediaUpload:
        if upload.id not in self.rows:
            stamp = datetime(2026, 11, 1, tzinfo=UTC) + timedelta(seconds=len(self.rows))
            self.rows[upload.id] = replace(upload, created_at=stamp)
        return self.rows[upload.id]

    async def get(self, upload_id: uuid.UUID) -> MediaUpload | None:
        return self.rows.get(upload_id)

    async def earliest_video_with_md5(self, content_md5: str) -> MediaUpload | None:
        found = [
            row
            for row in self.rows.values()
            if row.kind == "video" and row.content_md5 == content_md5
        ]
        return min(found, key=lambda row: (row.created_at, row.id), default=None)

    async def owned_video_at(self, owner: uuid.UUID, url: str) -> bool:
        return any(
            row.kind == "video" and row.owner_user_id == owner and row.url == url
            for row in self.rows.values()
        )

    async def list_in_conversation(
        self,
        conversation_id: uuid.UUID,
        *,
        limit: int,
        kind: MediaKind | None = None,
        before: MediaUpload | None = None,
        inherited: Inheritance = (),
    ) -> tuple[MediaUpload, ...]:
        raise AssertionError("列对话的上传在集成测试里覆盖")

    async def earliest_in_conversation(
        self, conversation_id: uuid.UUID, urls: Collection[str], *, inherited: Inheritance = ()
    ) -> Mapping[str, MediaUpload]:
        raise AssertionError("按地址对对话的上传在集成测试里覆盖")


__all__ = ["FakeBucket", "InMemoryUploadRepository"]
