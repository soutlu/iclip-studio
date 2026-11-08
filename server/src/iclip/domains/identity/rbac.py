from __future__ import annotations

from collections.abc import Iterable
from typing import Literal, get_args

# 使用 type 语句使 Pydantic 将 Permission 导出为独立的 OpenAPI Schema 组件。
type Permission = Literal[
    "collections:read",
    "collections:write",
    "tasks:read",
    "tasks:write",
    "inspirations:read",
    "library_tags:manage",
    "uploads:write",
    "generation:read",
    "generation:submit",
    "users:manage",
    "users:act_as",
    "api_keys:issue",
    "agent:read",
    "agent:run",
    "agent:manage",
    "model:manage",
]

PERMISSIONS: tuple[str, ...] = get_args(Permission.__value__)

MANAGE_PERMISSION: Permission = "users:manage"

ACT_AS_PERMISSION: Permission = "users:act_as"

AGENT_MANAGE_PERMISSION: Permission = "agent:manage"

_VIEWER = frozenset(
    {
        "collections:read",
        "tasks:read",
        "inspirations:read",
        "generation:read",
        "agent:read",
    }
)
_EDITOR = frozenset(PERMISSIONS) - {
    MANAGE_PERMISSION,
    ACT_AS_PERMISSION,
    "api_keys:issue",
    "library_tags:manage",
    "agent:manage",
    "model:manage",
}
_ROOT = frozenset(PERMISSIONS)
_ADMIN = _ROOT - {AGENT_MANAGE_PERMISSION, "model:manage"}

ROLE_PERMISSIONS: dict[str, frozenset[str]] = {
    "root": _ROOT,
    "admin": _ADMIN,
    "editor": _EDITOR,
    "viewer": _VIEWER,
}

ROLES: tuple[str, ...] = tuple(ROLE_PERMISSIONS)

ROOT_ROLE = "root"


def effective_permissions(
    roles: Iterable[str], direct_permissions: Iterable[str] = ()
) -> frozenset[str]:
    granted = frozenset(direct_permissions)
    for role in roles:
        granted |= ROLE_PERMISSIONS.get(role, frozenset())
    return granted


def is_known_role(role: str) -> bool:
    return role in ROLE_PERMISSIONS


__all__ = [
    "ACT_AS_PERMISSION",
    "AGENT_MANAGE_PERMISSION",
    "MANAGE_PERMISSION",
    "PERMISSIONS",
    "ROLES",
    "ROLE_PERMISSIONS",
    "ROOT_ROLE",
    "Permission",
    "effective_permissions",
    "is_known_role",
]
