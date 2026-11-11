"""进程内的假 MCP 服务与它的假 OAuth 授权服务器，挂在给运行时的 httpx2 传输上，不出网。

``https://mcp.test/<路径>`` 都是要按用户登录的 MCP 服务；``https://plain.test/…`` 没公布授权服务器，
``https://down.test/…`` 一直答 503。账户名经 userinfo 给出。
"""

from __future__ import annotations

import base64
import hashlib
import itertools
import json
from dataclasses import dataclass, field
from typing import Any, Final
from urllib.parse import parse_qs, urlsplit

import httpx2

MCP_ORIGIN: Final = "https://mcp.test"
ISSUER: Final = "https://auth.test"
UNSUPPORTED_URL: Final = "https://plain.test/mcp"
UNAVAILABLE_URL: Final = "https://down.test/mcp"

_PROTECTED_PREFIX: Final = "/.well-known/oauth-protected-resource"


@dataclass
class _Grant:
    client_id: str
    redirect_uri: str
    challenge: str
    email: str


@dataclass
class FakeAuthServer:
    registration: bool = True
    redirect_uris: dict[str, list[str]] = field(default_factory=dict[str, list[str]])
    _grants: dict[str, _Grant] = field(default_factory=dict[str, _Grant])
    _access: dict[str, str] = field(default_factory=dict[str, str])
    _ids: Any = field(default_factory=lambda: itertools.count(1))

    @property
    def transport(self) -> httpx2.MockTransport:
        return httpx2.MockTransport(self._handle)

    def consent(self, authorization_url: str, *, email: str) -> tuple[str, str]:
        """用户在授权页点了同意：发一个授权码，返回回调会带的 (state, code)。"""

        query = authorization_query(authorization_url)
        code = f"code-{next(self._ids)}"
        self._grants[code] = _Grant(
            client_id=query["client_id"],
            redirect_uri=query["redirect_uri"],
            challenge=query["code_challenge"],
            email=email,
        )
        return query["state"], code

    async def _handle(self, request: httpx2.Request) -> httpx2.Response:
        url = request.url
        if url.host == "down.test":
            return httpx2.Response(503)
        if url.host == "mcp.test":
            return self._mcp(request)
        if url.host != "auth.test":
            return httpx2.Response(404)
        route = (request.method, url.path)
        if route == ("GET", "/.well-known/oauth-authorization-server"):
            return httpx2.Response(200, json=self._metadata())
        if route == ("POST", "/register") and self.registration:
            return self._register(json.loads(request.content))
        if route == ("POST", "/token"):
            return self._token(request)
        if route == ("GET", "/userinfo"):
            email = self._access.get(
                request.headers.get("authorization", "").removeprefix("Bearer ")
            )
            if email is None:
                return httpx2.Response(401)
            return httpx2.Response(200, json={"email": email})
        return httpx2.Response(404)

    def _mcp(self, request: httpx2.Request) -> httpx2.Response:
        path = request.url.path
        if path.startswith(_PROTECTED_PREFIX):
            return httpx2.Response(
                200,
                json={
                    "resource": f"{MCP_ORIGIN}{path.removeprefix(_PROTECTED_PREFIX)}",
                    "authorization_servers": [ISSUER],
                    "scopes_supported": ["surveys:read", "surveys:write"],
                },
            )
        return httpx2.Response(
            401,
            headers={
                "WWW-Authenticate": f'Bearer resource_metadata="{MCP_ORIGIN}{_PROTECTED_PREFIX}{path}"'
            },
        )

    def _metadata(self) -> dict[str, Any]:
        document: dict[str, Any] = {
            "issuer": ISSUER,
            "authorization_endpoint": f"{ISSUER}/authorize",
            "token_endpoint": f"{ISSUER}/token",
            "userinfo_endpoint": f"{ISSUER}/userinfo",
            "response_types_supported": ["code"],
            "code_challenge_methods_supported": ["S256"],
            "scopes_supported": ["surveys:read", "surveys:write", "email", "offline_access"],
        }
        if self.registration:
            document["registration_endpoint"] = f"{ISSUER}/register"
        return document

    def _register(self, body: dict[str, Any]) -> httpx2.Response:
        client_id = f"client-{next(self._ids)}"
        self.redirect_uris[client_id] = list(body["redirect_uris"])
        return httpx2.Response(
            201,
            json={
                "client_id": client_id,
                "token_endpoint_auth_method": "none",
                "redirect_uris": body["redirect_uris"],
            },
        )

    def _token(self, request: httpx2.Request) -> httpx2.Response:
        form = {key: values[0] for key, values in parse_qs(request.content.decode()).items()}
        grant = self._grants.pop(form.get("code", ""), None)
        verifier = form.get("code_verifier", "")
        challenge = (
            base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
            .rstrip(b"=")
            .decode()
        )
        if (
            grant is None
            or grant.client_id != form.get("client_id")
            or grant.redirect_uri != form.get("redirect_uri")
            or grant.challenge != challenge
        ):
            return httpx2.Response(400, json={"error": "invalid_grant"})
        access = f"access-{next(self._ids)}"
        self._access[access] = grant.email
        return httpx2.Response(
            200,
            json={
                "access_token": access,
                "token_type": "bearer",
                "expires_in": 3600,
                "refresh_token": f"refresh-{access}",
                "scope": "surveys:read surveys:write email offline_access",
            },
        )


def authorization_query(authorization_url: str) -> dict[str, str]:
    return {key: values[0] for key, values in parse_qs(urlsplit(authorization_url).query).items()}


__all__ = [
    "ISSUER",
    "MCP_ORIGIN",
    "UNAVAILABLE_URL",
    "UNSUPPORTED_URL",
    "FakeAuthServer",
    "authorization_query",
]
