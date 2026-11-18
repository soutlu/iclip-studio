from __future__ import annotations

import httpx
from starlette.requests import Request
from starlette.responses import PlainTextResponse
from starlette.types import Receive, Scope, Send

from iclip.domains.identity.middleware import PrincipalMiddleware, PrincipalResolver, principal_of
from iclip.domains.identity.models import ApiKeyRecord, UserAccount
from iclip.domains.identity.service import IdentityService
from tests.helpers.identity import InMemoryApiKeyRepository, InMemoryUserRepository

INTERNAL_PREFIX = "/internal/runtime/"


class CountingApiKeys(InMemoryApiKeyRepository):
    def __init__(self) -> None:
        super().__init__()
        self.lookups = 0

    async def get_by_hash(self, token_hash: str) -> ApiKeyRecord | None:
        self.lookups += 1
        return await super().get_by_hash(token_hash)


async def _no_session_user(_token: str) -> UserAccount | None:
    return None


async def _echo_principal(scope: Scope, receive: Receive, send: Send) -> None:
    request = Request(scope, receive)
    anonymous = principal_of(request) is None
    await PlainTextResponse("anonymous" if anonymous else "resolved")(scope, receive, send)


async def test_an_internal_path_never_looks_up_an_api_key() -> None:
    api_keys = CountingApiKeys()
    resolver = PrincipalResolver(
        read_session_user=_no_session_user,
        service=IdentityService(InMemoryUserRepository(), api_keys),
        session_cookie_name="iclip_session",
    )
    app = PrincipalMiddleware(
        _echo_principal, resolver=resolver, anonymous_prefixes=(INTERNAL_PREFIX,)
    )
    bearer = {"Authorization": "Bearer runtime-internal-token-0123456789-abcdef"}

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        internal = await client.post(f"{INTERNAL_PREFIX}hooks/gate", headers=bearer)
        assert (internal.text, api_keys.lookups) == ("anonymous", 0)

        public = await client.get("/conversations", headers=bearer)
        assert (public.text, api_keys.lookups) == ("anonymous", 1)
