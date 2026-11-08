from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal

PrincipalKind = Literal["user", "api_key"]


@dataclass(frozen=True, slots=True)
class PmsDepartment:
    id: int
    uid: str
    name: str
    parent_id: int | None
    parent_uid: str
    leader_user_id: int | None
    leader_user_uid: str
    source: str
    type: str
    order: int | None


@dataclass(frozen=True, slots=True)
class UserAccount:
    id: uuid.UUID
    email: str
    username: str | None
    display_name: str
    avatar_url: str
    roles: tuple[str, ...]
    direct_permissions: frozenset[str]
    is_active: bool
    city: str
    job_title: str
    departments: tuple[PmsDepartment, ...]
    created_at: datetime | None
    last_login_at: datetime | None


@dataclass(frozen=True, slots=True)
class ApiKeyRecord:
    id: uuid.UUID
    owner_user_id: uuid.UUID
    name: str
    token_prefix: str
    permissions: frozenset[str]
    expires_at: datetime | None
    revoked_at: datetime | None
    last_used_at: datetime | None
    created_at: datetime | None


@dataclass(frozen=True, slots=True)
class Principal:
    kind: PrincipalKind
    user_id: uuid.UUID
    permissions: frozenset[str]
    audit_label: str
    api_key_id: uuid.UUID | None = field(default=None)
    username: str | None = field(default=None)
    key_name: str | None = field(default=None)

    def has(self, permission: str) -> bool:
        return permission in self.permissions


__all__ = [
    "ApiKeyRecord",
    "PmsDepartment",
    "Principal",
    "PrincipalKind",
    "UserAccount",
]
