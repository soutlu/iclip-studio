from __future__ import annotations

import uuid
from datetime import datetime
from typing import Protocol

from iclip.domains.identity.models import ApiKeyRecord, PmsDepartment, UserAccount


class UserRepository(Protocol):
    async def get(self, user_id: uuid.UUID) -> UserAccount | None: ...

    async def list_page(
        self, *, offset: int, limit: int
    ) -> tuple[tuple[UserAccount, ...], int]: ...

    async def update_access_fields(
        self,
        user_id: uuid.UUID,
        *,
        roles: tuple[str, ...] | None,
        direct_permissions: frozenset[str] | None,
        is_active: bool | None,
    ) -> UserAccount | None: ...

    async def ensure_role(self, user_id: uuid.UUID, role: str) -> None: ...

    async def touch_last_login(self, user_id: uuid.UUID, at: datetime) -> None: ...

    async def ensure_by_name(self, username: str, *, email: str) -> uuid.UUID: ...

    async def sync_sso_profile(
        self,
        user_id: uuid.UUID,
        *,
        display_name: str,
        avatar_url: str,
        roles: tuple[str, ...] | None,
        city: str | None,
        job_title: str | None,
        departments: tuple[PmsDepartment, ...] | None,
    ) -> None: ...


class ApiKeyRepository(Protocol):
    async def add(self, record: ApiKeyRecord, *, token_hash: str) -> None: ...

    async def get(self, key_id: uuid.UUID) -> ApiKeyRecord | None: ...

    async def get_by_hash(self, token_hash: str) -> ApiKeyRecord | None: ...

    async def list_for_owner(self, owner: uuid.UUID | None) -> tuple[ApiKeyRecord, ...]: ...

    async def revoke(self, key_id: uuid.UUID, at: datetime) -> None: ...

    async def touch_last_used(self, key_id: uuid.UUID, at: datetime) -> None: ...


__all__ = ["ApiKeyRepository", "UserRepository"]
