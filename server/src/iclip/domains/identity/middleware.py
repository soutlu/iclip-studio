from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Annotated, Any
from urllib.parse import urlsplit

import structlog
from fastapi import Depends, FastAPI, HTTPException, Request, Security, WebSocket
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from fastapi.security import (
    APIKeyCookie,
    HTTPAuthorizationCredentials,
    HTTPBearer,
    SecurityScopes,
)
from starlette.datastructures import Headers
from starlette.requests import HTTPConnection
from starlette.types import ASGIApp, Receive, Scope, Send

from iclip.common.errors import DomainError
from iclip.domains.identity.models import Principal, UserAccount
from iclip.domains.identity.rbac import PERMISSIONS
from iclip.domains.identity.service import IdentityService

_SESSION_COOKIE_BASE_NAME = "iclip_session"
_SESSION_COOKIE_SCHEME_NAME = "SessionCookie"

# 只有这几种方法会改状态，来源检查只管它们。
_WRITE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
_FOREIGN_ORIGIN_DETAIL = "请求来源不在允许范围内，无法执行该操作"

_logger = structlog.stdlib.get_logger(__name__)


def session_cookie_name(*, secure: bool) -> str:
    """会话 Cookie 的名字，设置、读取、登出与 OpenAPI 都由这里取。

    ``secure`` 为真时带 ``__Host-`` 前缀：浏览器不允许子域名用 ``Domain`` 写这种名字的 Cookie，
    预览域名就伪造不了会话。前缀要求 Cookie 带 ``Secure``、``Path=/`` 且不带 ``Domain``，
    http 下浏览器会丢掉它，所以 ``secure`` 为假时用不带前缀的名字。"""

    return f"__Host-{_SESSION_COOKIE_BASE_NAME}" if secure else _SESSION_COOKIE_BASE_NAME


def session_cookie_scheme(*, secure: bool) -> APIKeyCookie:
    """按 ``secure`` 取名的会话 Cookie 安全方案，OpenAPI 里叫 ``SessionCookie``。"""

    return APIKeyCookie(
        name=session_cookie_name(secure=secure),
        scheme_name=_SESSION_COOKIE_SCHEME_NAME,
        auto_error=False,
    )


# 路由上的鉴权依赖在导入时声明，那时还不知道配置。它只用来在 OpenAPI 里声明方案，取到的值不用；
# 文档里的 Cookie 名由 document_session_cookie 按配置写入。
_SESSION_COOKIE_DECLARATION = session_cookie_scheme(secure=False)
BEARER_TOKEN = HTTPBearer(scheme_name="BearerToken", auto_error=False)

SessionUserReader = Callable[[str], Awaitable[UserAccount | None]]


@dataclass(frozen=True, slots=True)
class PrincipalResolver:
    read_session_user: SessionUserReader
    service: IdentityService
    session_cookie_name: str

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
        raw_token = cookies.get(self.session_cookie_name)
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
    _session_cookie: Annotated[str | None, Depends(_SESSION_COOKIE_DECLARATION)],
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


def origin_allowed(headers: Mapping[str, str], allowed_origins: tuple[str, ...]) -> bool:
    """浏览器发来的请求是否来自允许的来源，写请求与 WebSocket 握手共用这一条规则。

    没有 ``Origin`` 的放行（非浏览器的调用方）；``Origin`` 的主机和端口等于请求的 ``Host``，或在
    ``allowed_origins`` 里的放行；其余（包括 ``Origin: null`` 与同站的其他子域名）拒绝。"""

    origin = headers.get("origin")
    if origin is None:
        return True
    if origin in allowed_origins:
        return True
    host = headers.get("host", "")
    return bool(host) and urlsplit(origin).netloc == host


class WriteOriginCheck:
    """``POST``、``PUT``、``PATCH``、``DELETE`` 请求的来源不被 ``origin_allowed`` 放行时直接答 ``403``，
    不进入后面的中间件和路由。同站的子域名能带着会话 Cookie 发写请求（SameSite=Lax 拦不住），
    靠这一层挡住。"""

    def __init__(self, app: ASGIApp, *, allowed_origins: tuple[str, ...]) -> None:
        self._app = app
        self._allowed_origins = allowed_origins

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and scope["method"] in _WRITE_METHODS:
            headers = Headers(scope=scope)
            if not origin_allowed(headers, self._allowed_origins):
                _logger.info(
                    "写请求被拒：Origin 不在允许范围",
                    method=scope["method"],
                    path=scope["path"],
                    origin=headers.get("origin"),
                    host=headers.get("host"),
                )
                response = JSONResponse({"detail": _FOREIGN_ORIGIN_DETAIL}, status_code=403)
                await response(scope, receive, send)
                return
        await self._app(scope, receive, send)


def document_session_cookie(app: FastAPI, *, secure: bool) -> None:
    """让 ``app`` 的 OpenAPI 文档里 ``SessionCookie`` 方案的 Cookie 名按 ``secure`` 取。

    路由上的鉴权依赖只声明了方案，名字以这里写入的为准；在 ``app.openapi`` 外再包一层。"""

    default_openapi = app.openapi
    definition = jsonable_encoder(
        session_cookie_scheme(secure=secure).model, by_alias=True, exclude_none=True
    )

    def openapi() -> dict[str, Any]:
        document = default_openapi()
        schemes = document.get("components", {}).get("securitySchemes", {})
        if _SESSION_COOKIE_SCHEME_NAME in schemes:
            schemes[_SESSION_COOKIE_SCHEME_NAME] = definition
        return document

    app.openapi = openapi


__all__ = [
    "BEARER_TOKEN",
    "PrincipalMiddleware",
    "PrincipalResolver",
    "WriteOriginCheck",
    "bind_principal",
    "document_session_cookie",
    "origin_allowed",
    "principal_of",
    "require_authenticated",
    "require_permission",
    "session_cookie_name",
    "session_cookie_scheme",
    "websocket_principal",
]
