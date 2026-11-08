from __future__ import annotations

import uuid

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import text

from tests.helpers.app import make_client
from tests.helpers.auth import register_and_login, set_roles_in_db
from tests.helpers.pg import connected

SSO_OK = {
    "result": "OK",
    "userSession": {
        "innerUserId": 42,
        "unionId": "u-42",
        "name": "Logan W",
        "email": "logan@corp.test",
        "avatarUrl": "https://a/1.png",
    },
}

PMS_OK = {
    "success": True,
    "data": {
        "city": "新加坡",
        "jobTitle": "策划",
        "depts": [
            {
                "id": 1,
                "uid": "d1",
                "name": "市场部",
                "parentId": None,
                "parentUid": "",
                "leaderUserId": None,
                "leaderUserUid": "",
                "source": "pms",
                "type": "dept",
                "order": 1,
            }
        ],
    },
}


def _json_transport(payload: object, status: int = 200) -> httpx.MockTransport:
    return httpx.MockTransport(lambda request: httpx.Response(status, json=payload))


@pytest.fixture
def sso_transport() -> httpx.MockTransport:
    return _json_transport(SSO_OK)


@pytest.fixture
def pms_transport() -> httpx.MockTransport | None:
    return _json_transport(PMS_OK)


async def test_authorize_exposes_issue_url(sso_app: FastAPI) -> None:
    async with make_client(sso_app) as client:
        response = await client.get("/auth/sso/authorize")
    assert response.status_code == 200
    url = response.json()["authorization_url"]
    assert url.startswith("https://sso.test/sso/issue/jwt?")
    assert "_fromApp=iclip" in url


async def test_first_login_creates_editor_with_pms_profile(sso_app: FastAPI) -> None:
    async with make_client(sso_app) as client:
        callback = await client.get("/auth/sso/callback", params={"jwt": "sso-jwt"})
        assert callback.status_code == 204, callback.text
        assert "iclip_session" in callback.headers.get("set-cookie", "")

        me = await client.get("/users/me")
    assert me.status_code == 200
    user = me.json()["user"]
    assert user["roles"] == ["editor"]
    assert user["displayName"] == "Logan W"
    assert user["username"] == "Logan W"
    assert user["email"] == "logan@corp.test"
    assert user["city"] == "新加坡"
    assert user["jobTitle"] == "策划"
    assert [d["name"] for d in user["departments"]] == ["市场部"]


async def test_second_login_reuses_account_and_keeps_roles(
    sso_app: FastAPI, migrated_pg: str
) -> None:
    async with make_client(sso_app) as client:
        assert (await client.get("/auth/sso/callback", params={"jwt": "j1"})).status_code == 204
    await set_roles_in_db(migrated_pg, "logan@corp.test", ["root", "editor"])

    async with make_client(sso_app) as client:
        assert (await client.get("/auth/sso/callback", params={"jwt": "j2"})).status_code == 204
        me = await client.get("/users/me")
    user = me.json()["user"]
    assert user["roles"] == ["root", "editor"]


class TestBindingToExistingAccount:
    @pytest.fixture
    def sso_transport(self) -> httpx.MockTransport:
        return _json_transport(
            {
                "result": "OK",
                "userSession": {
                    "innerUserId": 42,
                    "unionId": "u-42",
                    "name": "Logan W",
                    "email": "logan@example.com",
                    "avatarUrl": "https://a/1.png",
                },
            }
        )

    async def test_first_sso_login_keeps_existing_roles(
        self, sso_app: FastAPI, migrated_pg: str
    ) -> None:
        async with make_client(sso_app) as client:
            await register_and_login(client, username="logan", email="logan@example.com")
        await set_roles_in_db(migrated_pg, "logan@example.com", ["root"])

        async with make_client(sso_app) as client:
            assert (await client.get("/auth/sso/callback", params={"jwt": "j"})).status_code == 204
            me = await client.get("/users/me")
        user = me.json()["user"]
        assert user["roles"] == ["root"]
        assert user["city"] == "新加坡"
        assert user["username"] == "logan"


class TestConfiguredOAuthName:
    @pytest.fixture
    def sso_oauth_name(self) -> str | None:
        return "legacy_sso"

    async def test_callback_signs_in_account_linked_under_configured_name(
        self, sso_app: FastAPI, migrated_pg: str
    ) -> None:
        async with make_client(sso_app) as client:
            user_id = await register_and_login(client, username="old", email="old@example.com")
        async with connected(migrated_pg) as conn:
            await conn.execute(
                text(
                    "INSERT INTO iclip.oauth_accounts"
                    " (id, user_id, oauth_name, access_token, account_id, account_email)"
                    " VALUES (:id, :user_id, :oauth_name, 'old-jwt', :account_id, :email)"
                ),
                {
                    "id": uuid.uuid4(),
                    "user_id": uuid.UUID(user_id),
                    "oauth_name": "legacy_sso",
                    "account_id": "u-42",
                    "email": "old@example.com",
                },
            )

        async with make_client(sso_app) as client:
            assert (await client.get("/auth/sso/callback", params={"jwt": "j"})).status_code == 204
            me = (await client.get("/users/me")).json()["user"]
        assert (me["id"], me["email"]) == (user_id, "old@example.com")


class TestDisplayNameAlreadyTaken:
    @pytest.fixture
    def sso_transport(self) -> httpx.MockTransport:
        sessions = iter(
            [
                {
                    "innerUserId": 42,
                    "unionId": "u-42",
                    "name": "Logan W",
                    "email": "logan@corp.test",
                },
                {
                    "innerUserId": 43,
                    "unionId": "u-43",
                    "name": "Logan W",
                    "email": "logan2@corp.test",
                },
            ]
        )
        return httpx.MockTransport(
            lambda request: httpx.Response(
                200, json={"result": "OK", "userSession": {**next(sessions), "avatarUrl": ""}}
            )
        )

    async def test_second_account_with_same_name_has_no_username(self, sso_app: FastAPI) -> None:
        async with make_client(sso_app) as client:
            assert (await client.get("/auth/sso/callback", params={"jwt": "j1"})).status_code == 204
            assert (await client.get("/users/me")).json()["user"]["username"] == "Logan W"
        async with make_client(sso_app) as other:
            assert (await other.get("/auth/sso/callback", params={"jwt": "j2"})).status_code == 204
            user = (await other.get("/users/me")).json()["user"]
        assert user["email"] == "logan2@corp.test"
        assert user["username"] is None


class TestRootBootstrap:
    @pytest.fixture
    def root_email(self) -> str | None:
        return "LOGAN@corp.test"

    async def test_configured_root_email_gets_root_role(self, sso_app: FastAPI) -> None:
        async with make_client(sso_app) as client:
            assert (await client.get("/auth/sso/callback", params={"jwt": "j"})).status_code == 204
            me = await client.get("/users/me")
        user = me.json()["user"]
        assert set(user["roles"]) == {"editor", "root"}
        assert "api_keys:issue" in user["permissions"]


class TestFailurePaths:
    @pytest.fixture
    def sso_transport(self) -> httpx.MockTransport:
        return _json_transport({"result": "EXPIRED"})

    async def test_invalid_sso_session_is_401_without_cookie(self, sso_app: FastAPI) -> None:
        async with make_client(sso_app) as client:
            response = await client.get("/auth/sso/callback", params={"jwt": "bad"})
        assert response.status_code == 401
        assert "set-cookie" not in response.headers


class TestPmsFailureAborts:
    @pytest.fixture
    def sso_transport(self) -> httpx.MockTransport:
        return _json_transport(SSO_OK)

    @pytest.fixture
    def pms_transport(self) -> httpx.MockTransport | None:
        return _json_transport({"success": False, "responseDesc": "boom"})

    async def test_pms_failure_terminates_callback(self, sso_app: FastAPI) -> None:
        async with make_client(sso_app) as client:
            response = await client.get("/auth/sso/callback", params={"jwt": "j"})
            assert response.status_code == 502
            assert "set-cookie" not in response.headers
            assert (await client.get("/users/me")).status_code == 401


async def test_sso_routes_absent_when_disabled(client: httpx.AsyncClient) -> None:
    assert (await client.get("/auth/sso/authorize")).status_code == 404
