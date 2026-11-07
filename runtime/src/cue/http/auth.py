from __future__ import annotations

import hmac
import uuid
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, Header
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from cue.app_wire import END_USER_HEADER
from cue.errors import AuthenticationFailed, PermissionDenied
from cue.settings import ResolvedApp

_bearer = HTTPBearer(
    scheme_name="AppKey",
    description="接入应用的密钥，按运行时配置里的 apps 认出是哪个应用。",
    auto_error=False,
)

EndUser = Annotated[
    uuid.UUID,
    Header(alias=END_USER_HEADER, description="代哪个用户操作：用户 id。管理接口的写操作必填。"),
]

SessionOwner = Annotated[
    uuid.UUID,
    Header(
        alias=END_USER_HEADER,
        description="会话的属主：用户 id。应用替看的人转发时也给属主，不给看的人。",
    ),
]


@dataclass(frozen=True, slots=True)
class CallingApp:
    id: str
    admin: bool


@dataclass(frozen=True, slots=True)
class AppAuth:
    calling_app: Callable[..., Awaitable[CallingApp]]
    admin_app: Callable[..., Awaitable[CallingApp]]
    identify: Callable[[str | None], CallingApp | None]


def build_app_auth(apps: Sequence[ResolvedApp]) -> AppAuth:
    known = tuple((app.key.encode(), CallingApp(id=app.id, admin=app.admin)) for app in apps)

    def match(presented: str) -> CallingApp | None:
        found: CallingApp | None = None
        for key, app in known:
            if hmac.compare_digest(key, presented.encode()):
                found = app
        return found

    async def calling_app(
        credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    ) -> CallingApp:
        if credentials is None:
            raise AuthenticationFailed("缺少应用密钥")
        found = match(credentials.credentials)
        if found is None:
            raise AuthenticationFailed("应用密钥无效")
        return found

    def identify(authorization: str | None) -> CallingApp | None:
        scheme, _, presented = (authorization or "").partition(" ")
        if scheme.lower() != "bearer" or not presented:
            return None
        return match(presented.strip())

    async def admin_app(app: CallingApp = Depends(calling_app)) -> CallingApp:  # noqa: B008
        if not app.admin:
            raise PermissionDenied("这个应用没有管理权限")
        return app

    return AppAuth(calling_app=calling_app, admin_app=admin_app, identify=identify)


__all__ = [
    "AppAuth",
    "CallingApp",
    "EndUser",
    "SessionOwner",
    "build_app_auth",
]
