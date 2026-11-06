from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from iclip.domains.identity.rbac import Permission


@dataclass(frozen=True, slots=True)
class CreateApiKey:
    name: str
    permissions: frozenset[Permission]
    expires_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class UpdateUser:
    roles: tuple[str, ...] | None = None
    direct_permissions: frozenset[Permission] | None = None
    is_active: bool | None = None


__all__ = ["CreateApiKey", "UpdateUser"]
