from __future__ import annotations

import uuid
from dataclasses import replace

import structlog

from iclip.domains.identity.models import Principal
from iclip.domains.identity.rbac import ACT_AS_PERMISSION
from iclip.domains.identity.repository import UserRepository
from iclip.domains.identity.sso import SSO_EMAIL_PLACEHOLDER_DOMAIN
from iclip.domains.identity.user_name import require_own_user_name

_PLACEHOLDER_NAMESPACE = uuid.UUID("8f0c6a1e-5b7d-4e2a-9c3f-1d4b6e8a0c2f")


def placeholder_email(username: str) -> str:
    return f"{uuid.uuid5(_PLACEHOLDER_NAMESPACE, username).hex}@{SSO_EMAIL_PLACEHOLDER_DOMAIN}"


def is_placeholder_account(username: str, email: str) -> bool:
    return email == placeholder_email(username)


class ActAs:
    def __init__(self, users: UserRepository) -> None:
        self._users = users

    async def __call__(self, principal: Principal, user_name: str | None) -> Principal:
        name = user_name.strip() if user_name else ""
        if not name:
            return principal
        if principal.kind != "api_key":
            require_own_user_name(principal, name)
            return principal
        if not principal.has(ACT_AS_PERMISSION):
            return principal
        user_id = await self._users.ensure_by_name(name, email=placeholder_email(name))
        structlog.contextvars.bind_contextvars(acting_as=name)
        return replace(
            principal,
            user_id=user_id,
            username=name,
            audit_label=f"{name}#{principal.key_name}",
        )


__all__ = ["ActAs", "is_placeholder_account", "placeholder_email"]
