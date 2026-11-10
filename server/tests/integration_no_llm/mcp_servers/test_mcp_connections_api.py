from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncEngine

from tests.helpers.app import make_client, make_runtime_config
from tests.helpers.auth import login_as_editor, register_and_login, set_roles_in_db
from tests.helpers.mcp_oauth import (
    ISSUER,
    MCP_ORIGIN,
    UNAVAILABLE_URL,
    UNSUPPORTED_URL,
    FakeAuthServer,
    authorization_query,
)
from tests.helpers.runtime_backed import build_backed_app

APP_ORIGIN = "https://app.test"

CALLBACK = f"{APP_ORIGIN}/mcp/callback"


@pytest.fixture
def auth_server() -> FakeAuthServer:
    return FakeAuthServer()


@pytest.fixture
def sso_on() -> bool:
    return True


@pytest.fixture
def app(
    monkeypatch: pytest.MonkeyPatch,
    base_env: None,
    engine: AsyncEngine,
    auth_server: FakeAuthServer,
    sso_on: bool,
    tmp_path: Path,
) -> FastAPI:
    if sso_on:
        monkeypatch.setenv("SSO_BASE_URL", "https://sso.test")
        monkeypatch.setenv("SSO_REDIRECT_URL", f"{APP_ORIGIN}/auth/sso/landing")
    return build_backed_app(
        make_runtime_config(),
        engine=engine,
        skill_cache_dir=tmp_path / "skills",
        oauth_transport=auth_server.transport,
    )


@pytest.fixture
async def member(app: FastAPI, migrated_pg: str) -> AsyncIterator[httpx.AsyncClient]:
    async with make_client(app) as other:
        await login_as_editor(other, migrated_pg, username="mia")
        yield other


async def login_as_root(client: httpx.AsyncClient, pg_url: str) -> None:
    await register_and_login(client, username="root", email="root@example.com")
    await set_roles_in_db(pg_url, "root@example.com", ["root"])


def per_user(server_id: str, url: str | None = None, **extra: Any) -> dict[str, Any]:
    return {
        "id": server_id,
        "name": server_id,
        "url": url or f"{MCP_ORIGIN}/{server_id}",
        "transport": "streamable_http",
        "authMode": "per_user",
        **extra,
    }


async def create(client: httpx.AsyncClient, body: dict[str, Any]) -> dict[str, Any]:
    created = await client.post("/mcp-servers", json=body)
    assert created.status_code == 201, created.text
    return created.json()


async def connect(
    client: httpx.AsyncClient, auth_server: FakeAuthServer, server_id: str, *, email: str
) -> httpx.Response:
    started = await client.post(f"/mcp-connections/{server_id}/authorize")
    assert started.status_code == 200, started.text
    state, code = auth_server.consent(started.json()["authorizationUrl"], email=email)
    return await client.post("/mcp-connections/complete", json={"state": state, "code": code})


async def states(client: httpx.AsyncClient, **params: str) -> dict[str, str]:
    listed = await client.get("/mcp-connections", params=params)
    assert listed.status_code == 200, listed.text
    return {one["serverId"]: one["state"] for one in listed.json()["items"]}


async def test_admin_routes_carry_per_user_settings_and_the_affected_count(
    client: httpx.AsyncClient, migrated_pg: str, auth_server: FakeAuthServer
) -> None:
    await login_as_root(client, migrated_pg)
    created = await create(client, per_user("calc", oauthScopes=["surveys:read", "surveys:write"]))
    assert created["authMode"] == "per_user"
    assert created["oauth"]["scopes"] == ["surveys:read", "surveys:write"]
    assert created["oauth"]["client"] == "unknown"
    preset = await create(
        client,
        per_user("closed", oauthClient={"clientId": "preset-1", "clientSecret": "s3cret-value"}),
    )
    assert preset["oauth"]["presetClient"]["clientId"] == "preset-1"
    assert "s3cret-value" not in str(preset)

    assert (await connect(client, auth_server, "calc", email="root@example.com")).is_success
    assert (await client.get("/mcp-servers/calc")).json()["oauth"]["connectedUsers"] == 1

    narrowed = await client.patch("/mcp-servers/calc", json={"oauthScopes": ["surveys:read"]})
    assert narrowed.status_code == 409, narrowed.text
    assert narrowed.json() == {
        "detail": narrowed.json()["detail"],
        "code": "mcp_connections_affected",
        "affectedUsers": 1,
    }
    assert (await client.get("/mcp-servers/calc")).json()["oauth"]["scopes"] == [
        "surveys:read",
        "surveys:write",
    ]

    confirmed = await client.patch(
        "/mcp-servers/calc", json={"oauthScopes": ["surveys:read"], "confirmReconnect": True}
    )
    assert confirmed.status_code == 200, confirmed.text
    assert confirmed.json()["oauth"]["scopes"] == ["surveys:read"]
    assert (await states(client))["calc"] == "invalid"


async def test_checking_a_per_user_server_uses_the_admins_own_connection(
    client: httpx.AsyncClient, migrated_pg: str, auth_server: FakeAuthServer
) -> None:
    await login_as_root(client, migrated_pg)
    await create(client, per_user("calc", oauthScopes=["surveys:read", "surveys:write"]))

    unsaved = await client.post(
        "/mcp-servers/check",
        json={"url": f"{MCP_ORIGIN}/draft", "transport": "streamable_http", "authMode": "per_user"},
    )
    assert unsaved.status_code == 422, unsaved.text

    not_connected = await client.post("/mcp-servers/calc/check")
    assert not_connected.status_code == 409, not_connected.text
    assert not_connected.json()["code"] == "mcp_not_connected"

    assert (await connect(client, auth_server, "calc", email="root@example.com")).is_success
    narrowed = await client.patch(
        "/mcp-servers/calc", json={"oauthScopes": ["surveys:read"], "confirmReconnect": True}
    )
    assert narrowed.status_code == 200, narrowed.text
    stale = await client.post("/mcp-servers/calc/check")
    assert stale.status_code == 409, stale.text
    assert stale.json()["code"] == "mcp_reconnect_required"
    assert (await client.get("/mcp-servers/calc")).json()["lastCheck"] is None


async def test_member_connects_as_themselves_with_the_configured_callback(
    client: httpx.AsyncClient,
    member: httpx.AsyncClient,
    migrated_pg: str,
    auth_server: FakeAuthServer,
) -> None:
    await login_as_root(client, migrated_pg)
    await create(client, per_user("calc"))
    await create(client, {**per_user("shared"), "authMode": "shared"})

    assert await states(member) == {"calc": "none"}

    started = await member.post(
        "/mcp-connections/calc/authorize",
        params={"redirectUri": "https://evil.test/steal"},
        headers={"Origin": "https://evil.test", "Referer": "https://evil.test/page"},
        json={"redirectUri": "https://evil.test/steal"},
    )
    assert started.status_code == 200, started.text
    sent = authorization_query(started.json()["authorizationUrl"])["redirect_uri"]
    assert sent == CALLBACK
    assert list(auth_server.redirect_uris.values()) == [[CALLBACK]]
    shown = await client.get("/mcp-servers:callback-url")
    assert shown.status_code == 200, shown.text
    assert shown.json() == {"callbackUrl": sent}
    assert (await member.get("/mcp-servers:callback-url")).status_code == 403

    state, code = auth_server.consent(started.json()["authorizationUrl"], email="mia@corp.test")
    done = await member.post(
        "/mcp-connections/complete", json={"state": state, "code": code, "iss": ISSUER}
    )
    assert done.status_code == 200, done.text
    assert done.json() == {"serverId": "calc", "name": "calc", "account": "mia@corp.test"}

    listed = await member.get("/mcp-connections")
    (mine,) = listed.json()["items"]
    assert (mine["state"], mine["account"]) == ("connected", "mia@corp.test")
    assert "surveys:read" in mine["scopes"] and mine["connectedAt"] is not None
    assert await states(client) == {"calc": "none"}

    assert (await member.delete("/mcp-connections/calc")).status_code == 204
    assert await states(member) == {"calc": "none"}


async def test_only_the_person_who_started_can_finish(
    client: httpx.AsyncClient,
    member: httpx.AsyncClient,
    migrated_pg: str,
    auth_server: FakeAuthServer,
) -> None:
    await login_as_root(client, migrated_pg)
    await create(client, per_user("calc"))

    started = await client.post("/mcp-connections/calc/authorize")
    state, code = auth_server.consent(started.json()["authorizationUrl"], email="root@x.test")
    stolen = await member.post("/mcp-connections/complete", json={"state": state, "code": code})

    assert stolen.status_code == 409
    assert stolen.json()["code"] == "mcp_sign_in_foreign"
    assert await states(member) == {"calc": "none"}


async def test_agent_filter_and_the_draft_listing_for_managers(
    client: httpx.AsyncClient, member: httpx.AsyncClient, migrated_pg: str
) -> None:
    await login_as_root(client, migrated_pg)
    await create(client, per_user("calc"))
    await create(client, per_user("other"))
    assert (await client.post("/agents", json={"id": "director", "name": "导演"})).is_success
    tools = [
        {"type": "mcp", "server": "calc", "tools": []},
        {"type": "mcp", "server": "other", "tools": ["add", "send"], "approval_tools": ["send"]},
    ]
    saved = await client.put(
        "/agents/director/draft",
        json={"config": {"schema_version": 1, "tools": tools}, "skillIds": [], "lockVersion": 0},
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["draft"]["config"]["tools"] == tools

    assert await states(client, agentId="director", draft="true") == {
        "calc": "none",
        "other": "none",
    }
    assert await states(member, agentId="director") == {}
    assert (
        await member.get("/mcp-connections", params={"agentId": "director", "draft": "true"})
    ).status_code == 403
    assert (await member.get("/mcp-connections", params={"agentId": "nobody"})).status_code == 404


async def test_refusals_reach_the_web_with_their_codes(
    client: httpx.AsyncClient, migrated_pg: str, auth_server: FakeAuthServer
) -> None:
    await login_as_root(client, migrated_pg)
    await create(client, per_user("calc"))
    await create(client, per_user("plain", UNSUPPORTED_URL))
    await create(client, per_user("down", UNAVAILABLE_URL))

    async def code_of(response: httpx.Response) -> str:
        assert response.status_code == 409, response.text
        return response.json()["code"]

    assert (
        await code_of(
            await client.post("/mcp-connections/complete", json={"state": "nope", "code": "x"})
        )
        == "mcp_sign_in_expired"
    )
    started = await client.post("/mcp-connections/calc/authorize")
    state = authorization_query(started.json()["authorizationUrl"])["state"]
    assert (
        await code_of(
            await client.post("/mcp-connections/complete", json={"state": state, "code": "forged"})
        )
        == "mcp_oauth_rejected"
    )
    started = await client.post("/mcp-connections/calc/authorize")
    state, code = auth_server.consent(started.json()["authorizationUrl"], email="root@x.test")
    assert (
        await code_of(
            await client.post(
                "/mcp-connections/complete",
                json={"state": state, "code": code, "iss": "https://evil.test"},
            )
        )
        == "mcp_oauth_rejected"
    )
    assert (await states(client))["calc"] == "none"
    assert (
        await code_of(await client.post("/mcp-connections/plain/authorize"))
        == "mcp_oauth_unsupported"
    )
    assert (
        await code_of(await client.post("/mcp-connections/down/authorize"))
        == "mcp_oauth_unavailable"
    )
    auth_server.registration = False
    await create(client, per_user("closed"))
    assert (
        await code_of(await client.post("/mcp-connections/closed/authorize"))
        == "mcp_client_required"
    )
    assert (await client.get("/mcp-servers/closed")).json()["oauth"]["client"] == "required"


@pytest.mark.parametrize("sso_on", [False])
async def test_sign_in_needs_the_configured_front_end_address(
    client: httpx.AsyncClient, member: httpx.AsyncClient, migrated_pg: str
) -> None:
    await login_as_root(client, migrated_pg)
    await create(client, per_user("calc"))

    refused = await member.post("/mcp-connections/calc/authorize")

    assert refused.status_code == 409
    assert refused.json()["code"] == "mcp_callback_unconfigured"
    assert await states(member) == {"calc": "none"}
    assert (await client.get("/mcp-servers:callback-url")).json() == {"callbackUrl": None}
