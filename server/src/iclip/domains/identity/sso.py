from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import quote

import httpx

SSO_EMAIL_PLACEHOLDER_DOMAIN = "sso.iclip.example"

_ISSUE_PATH = "/sso/issue/jwt"
_VERIFY_PATH = "/sso/rpc/session/verify"
_TIMEOUT_SECONDS = 5.0


class SsoSessionInvalid(Exception):
    pass


class SsoUnavailable(Exception):
    pass


@dataclass(frozen=True, slots=True)
class SsoUserSession:
    inner_user_id: int
    union_id: str
    name: str
    email: str
    avatar_url: str


class SsoVerifier:
    def __init__(
        self,
        *,
        base_url: str,
        app_name: str,
        redirect_url: str,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._app_name = app_name
        self._redirect_url = redirect_url
        self._transport = transport

    def authorization_url(self) -> str:
        redirect = quote(self._redirect_url, safe="")
        return (
            f"{self._base_url}{_ISSUE_PATH}"
            f"?redirect_uri={redirect}&_fromApp={quote(self._app_name)}"
        )

    async def verify(self, jwt_token: str) -> SsoUserSession:
        url = f"{self._base_url}{_VERIFY_PATH}?jwt={quote(jwt_token)}"
        try:
            async with httpx.AsyncClient(
                timeout=_TIMEOUT_SECONDS, transport=self._transport
            ) as client:
                response = await client.get(url)
            payload = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise SsoUnavailable("SSO 验证服务不可达") from exc
        if not isinstance(payload, dict) or payload.get("result") != "OK":
            raise SsoSessionInvalid("SSO 会话无效或已过期")
        user_session = payload.get("userSession") or {}
        if not isinstance(user_session, dict):
            raise SsoUnavailable("SSO 响应 userSession 非法")
        inner_user_id = _positive_integer(user_session.get("innerUserId"))
        if inner_user_id is None:
            raise SsoUnavailable("SSO 响应缺少 innerUserId")
        union_id = str(user_session.get("unionId") or "").strip()
        if not union_id:
            raise SsoUnavailable("SSO 响应缺少 unionId")
        return SsoUserSession(
            inner_user_id=inner_user_id,
            union_id=union_id,
            name=str(user_session.get("name") or "").strip(),
            email=str(user_session.get("email") or "").strip(),
            avatar_url=str(user_session.get("avatarUrl") or "").strip(),
        )


def _positive_integer(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        parsed = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def sso_placeholder_email(union_id: str) -> str:
    return f"{union_id}@{SSO_EMAIL_PLACEHOLDER_DOMAIN}"


__all__ = [
    "SsoSessionInvalid",
    "SsoUnavailable",
    "SsoUserSession",
    "SsoVerifier",
    "sso_placeholder_email",
]
