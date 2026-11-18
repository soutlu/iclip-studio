from __future__ import annotations

import httpx
import pytest
from fastapi import FastAPI

from tests.helpers.app import make_client

SECURE_NAME = "__Host-iclip_session"
PLAIN_NAME = "iclip_session"
PASSWORD = "password-123"


def parse_set_cookie(response: httpx.Response) -> tuple[str, str, dict[str, str]]:
    """解析响应里唯一的一条 ``Set-Cookie``：名字、值与属性（属性名小写，没有值的属性取空串）。"""

    headers = response.headers.get_list("set-cookie")
    assert len(headers) == 1, headers
    pair, *attributes = (part.strip() for part in headers[0].split(";"))
    name, _, value = pair.partition("=")
    parsed: dict[str, str] = {}
    for attribute in attributes:
        key, _, attribute_value = attribute.partition("=")
        parsed[key.lower()] = attribute_value
    return name, value, parsed


async def register_and_login(client: httpx.AsyncClient) -> httpx.Response:
    created = await client.post(
        "/auth/register",
        json={"email": "logan@example.com", "password": PASSWORD, "username": "logan"},
    )
    assert created.status_code == 201, created.text
    logged_in = await client.post("/auth/login", data={"username": "logan", "password": PASSWORD})
    assert logged_in.status_code == 204, logged_in.text
    return logged_in


@pytest.mark.parametrize("cookie_secure", [True], ids=["secure"])
async def test_secure_mode_sets_a_host_prefixed_cookie_and_ignores_the_plain_name(
    app: FastAPI,
) -> None:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://test"
    ) as client:
        name, token, attributes = parse_set_cookie(await register_and_login(client))
        assert name == SECURE_NAME
        assert attributes["path"] == "/"
        assert "secure" in attributes
        assert "httponly" in attributes
        assert "domain" not in attributes
        assert (await client.get("/users/me")).status_code == 200

        async with make_client(app) as other:
            me = await other.get("/users/me", headers={"cookie": f"{PLAIN_NAME}={token}"})
            assert me.status_code == 401, "开 cookie_secure 后不带前缀的旧名字不算登录"

        logged_out = await client.post("/auth/logout")
        assert logged_out.status_code == 204, logged_out.text
        name, _, attributes = parse_set_cookie(logged_out)
        assert name == SECURE_NAME
        assert attributes["max-age"] == "0"
        assert attributes["path"] == "/"
        assert "secure" in attributes
        assert "domain" not in attributes
        assert (await client.get("/users/me")).status_code == 401

    scheme = app.openapi()["components"]["securitySchemes"]["SessionCookie"]
    assert scheme == {"type": "apiKey", "in": "cookie", "name": SECURE_NAME}


async def test_plain_mode_sets_the_unprefixed_cookie_without_secure(
    app: FastAPI, client: httpx.AsyncClient
) -> None:
    name, token, attributes = parse_set_cookie(await register_and_login(client))

    assert name == PLAIN_NAME
    assert attributes["path"] == "/"
    assert "secure" not in attributes
    assert "domain" not in attributes
    assert (await client.get("/users/me")).status_code == 200
    async with make_client(app) as other:
        me = await other.get("/users/me", headers={"cookie": f"{SECURE_NAME}={token}"})
        assert me.status_code == 401, "不开 cookie_secure 时只认不带前缀的名字"
    scheme = app.openapi()["components"]["securitySchemes"]["SessionCookie"]
    assert scheme["name"] == PLAIN_NAME
