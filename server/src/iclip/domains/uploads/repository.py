from __future__ import annotations

import uuid
from collections.abc import Collection, Mapping
from typing import Protocol

from iclip.domains.uploads.models import Inheritance, MediaKind, MediaUpload


class UploadRepository(Protocol):
    async def insert(self, upload: MediaUpload) -> MediaUpload:
        """记一条上传；同一个 id 已经记过时不改它，交回已有的那条。"""
        ...

    async def get(self, upload_id: uuid.UUID) -> MediaUpload | None: ...

    async def earliest_video_with_md5(self, content_md5: str) -> MediaUpload | None: ...

    async def list_in_conversation(
        self,
        conversation_id: uuid.UUID,
        *,
        limit: int,
        kind: MediaKind | None = None,
        before: MediaUpload | None = None,
        inherited: Inheritance = (),
    ) -> tuple[MediaUpload, ...]:
        """挂在这段对话上的上传，加上 ``inherited`` 里祖先对话在分叉时刻以前挂上的，新的在前。"""
        ...

    async def earliest_in_conversation(
        self, conversation_id: uuid.UUID, urls: Collection[str], *, inherited: Inheritance = ()
    ) -> Mapping[str, MediaUpload]:
        """这段对话（含 ``inherited``）里每个地址对上的最早那条上传；对不上的地址不在答复里。"""
        ...


__all__ = ["UploadRepository"]
