from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Literal

from cue.errors import PermissionDenied

from iclip.domains.collections.models import Collection
from iclip.domains.collections.repository import CollectionRepository
from iclip.domains.identity.public import MANAGE_PERMISSION, Principal, visible_owner
from iclip.platform.paging import MAX_LIST_LIMIT

Scope = Literal["me", "all"]


class CollectionService:
    def __init__(self, repo: CollectionRepository) -> None:
        self._repo = repo

    def _visible_to(self, principal: Principal, *, scope: Scope = "me") -> uuid.UUID | None:
        if scope == "me":
            return principal.user_id
        if not principal.has(MANAGE_PERMISSION):
            raise PermissionDenied("只有治理者能看全部合集")
        return None

    async def create(self, principal: Principal, *, name: str) -> Collection:

        now = datetime.now(UTC)
        return await self._repo.create(
            Collection(
                id=uuid.uuid4(),
                owner_user_id=principal.user_id,
                name=name,
                created_at=now,
                updated_at=now,
            )
        )

    async def get(self, principal: Principal, collection_id: uuid.UUID) -> Collection:
        return await self._repo.get(collection_id, owner=visible_owner(principal))

    async def list_recent(
        self, principal: Principal, *, scope: Scope = "me", limit: int = 20, offset: int = 0
    ) -> tuple[Collection, ...]:
        return await self._repo.list_recent(
            owner=self._visible_to(principal, scope=scope),
            limit=min(limit, MAX_LIST_LIMIT),
            offset=offset,
        )

    async def rename(
        self, principal: Principal, collection_id: uuid.UUID, *, name: str
    ) -> Collection:
        return await self._repo.rename(collection_id, owner=visible_owner(principal), name=name)

    async def delete(self, principal: Principal, collection_id: uuid.UUID) -> None:

        await self._repo.delete(collection_id, owner=visible_owner(principal))


__all__ = ["CollectionService", "Scope"]
