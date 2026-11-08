from __future__ import annotations

from iclip.common.errors import ValidationFailed
from iclip.domains.identity.models import Principal


def require_own_user_name(principal: Principal, name: str) -> None:
    if name != principal.username:
        raise ValidationFailed("user_name 必须是当前登录账号的用户名")


def resolve_user_name(principal: Principal, given: str | None) -> str:
    name = given.strip() if given is not None else ""
    if principal.kind == "api_key":
        if not name:
            raise ValidationFailed("user_name 必填")
        return name
    if principal.username is None:
        raise ValidationFailed("当前账号没有用户名，不能提交")
    if name:
        require_own_user_name(principal, name)
    return principal.username


__all__ = ["require_own_user_name", "resolve_user_name"]
