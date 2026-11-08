from __future__ import annotations

import uuid
from typing import Protocol

from iclip.domains.collections.models import Collection


class CollectionRepository(Protocol):
    async def create(self, collection: Collection) -> Collection: ...

    async def get(self, collection_id: uuid.UUID, *, owner: uuid.UUID | None) -> Collection: ...

    async def list_recent(
        self, *, owner: uuid.UUID | None, limit: int, offset: int = 0
    ) -> tuple[Collection, ...]: ...

    async def rename(
        self, collection_id: uuid.UUID, *, owner: uuid.UUID | None, name: str
    ) -> Collection: ...

    async def delete(self, collection_id: uuid.UUID, *, owner: uuid.UUID | None) -> None: ...


__all__ = ["CollectionRepository"]
