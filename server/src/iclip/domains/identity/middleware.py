from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Annotated, Any
from urllib.parse import urlsplit

import structlog
from fastapi import Depends, HTTPException, Request, Security, WebSocket
from fastapi.security import (
    APIKeyCookie,
    HTTPAuthorizationCredentials,
    HTTPBearer,
    SecurityScopes,
)
from starlette.requests import HTTPConnection
from starlette.types import ASGIApp, Receive, Scope, Send

from iclip.common.errors import DomainError
from iclip.domains.identity.models import Principal, UserAccount
from iclip.domains.identity.rbac import PERMISSIONS
from iclip.domains.identity.service import IdentityService

SESSION_COOKIE_NAME = "iclip_session"

SESSION_COOKIE = APIKeyCookie(
    name=SESSION_COOKIE_NAME, scheme_name="SessionCookie", auto_error=False
)
BEARER_TOKEN = HTTPBearer(scheme_name="BearerToken", auto_error=False)

SessionUserReader = Callable[[str], Awaitable[UserAccount | None]]


@dataclass(frozen=True, slots=True)
class PrincipalResolver:
    read_session_user: SessionUserReader
    service: IdentityService

    async def resolve(
        self, headers: Mapping[str, str], cookies: Mapping[str, str]
    ) -> Principal | None:
        scheme, _, bearer_token = headers.get("authorization", "").partition(" ")
        if scheme.lower() == "bearer":
            token = bearer_token.strip()
            if not token:
                return None
            try:
                return await self.service.authenticate_api_key(token)
            except DomainError:
                return None
        raw_token = cookies.get(SESSION_COOKIE_NAME)
        if not raw_token:
            return None
        account = await self.read_session_user(raw_token)
        if account is None:
            return None
        try:
            return self.service.principal_for_user(account)
        except DomainError:
            return None


class PrincipalMiddleware:
    def __init__(
        self,
        app: ASGIApp,
        resolver: PrincipalResolver,
        anonymous_prefixes: tuple[str, ...] = (),
    ) -> None:
        self._app = app
        self._resolver = resolver
        self._anonymous_prefixes = anonymous_prefixes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] in {"http", "websocket"}:
            structlog.contextvars.clear_contextvars()
            structlog.contextvars.bind_contextvars(request_id=uuid.uuid4().hex[:12])
            connection = HTTPConnection(scope)
            principal = (
                None
                if str(scope["path"]).startswith(self._anonymous_prefixes)
                else await self._resolver.resolve(connection.headers, connection.cookies)
            )
            if principal is not None:
                structlog.contextvars.bind_contextvars(principal=principal.audit_label)
            bind_principal(connection, principal)
        await self._app(scope, receive, send)


def bind_principal(connection: HTTPConnection, principal: Principal | None) -> None:
    connection.state.principal = principal


def principal_of(request: Request) -> Principal | None:
    return getattr(request.state, "principal", None)


def websocket_principal(websocket: WebSocket) -> Principal | None:
    return getattr(websocket.state, "principal", None)


async def require_authenticated(
    security_scopes: SecurityScopes,
    request: Request,
    _session_cookie: Annotated[str | None, Depends(SESSION_COOKIE)],
    _bearer_token: Annotated[HTTPAuthorizationCredentials | None, Depends(BEARER_TOKEN)],
) -> Principal:
    principal = principal_of(request)
    if principal is None:
        raise HTTPException(status_code=401, detail="未登录或凭证无效")
    missing = [scope for scope in security_scopes.scopes if not principal.has(scope)]
    if missing:
        raise HTTPException(status_code=403, detail=f"需要 {'、'.join(missing)} 权限")
    return principal


def require_permission(*permissions: str) -> Any:
    if not permissions:
        raise ValueError("require_permission 至少声明一项权限；只要登录用 require_authenticated")
    unknown = [permission for permission in permissions if permission not in PERMISSIONS]
    if unknown:
        raise ValueError(f"未知权限: {', '.join(unknown)}")
    return Security(require_authenticated, scopes=list(permissions))


def websocket_origin_allowed(websocket: WebSocket, allowed_origins: tuple[str, ...]) -> bool:
    origin = websocket.headers.get("origin")
    if origin is None:
        return True
    if origin in allowed_origins:
        return True
    host = websocket.headers.get("host", "")
    return bool(host) and urlsplit(origin).netloc == host


__all__ = [
    "BEARER_TOKEN",
    "SESSION_COOKIE",
    "SESSION_COOKIE_NAME",
    "PrincipalMiddleware",
    "PrincipalResolver",
    "bind_principal",
    "principal_of",
    "require_authenticated",
    "require_permission",
    "websocket_origin_allowed",
    "websocket_principal",
]
