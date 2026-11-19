"""root 给用户选配置组：只有 root 能改，组名必须在部署配置里。"""

from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncEngine

from tests.helpers.app import make_client, make_runtime_config
from tests.helpers.auth import register_and_login, set_roles_in_db
from tests.helpers.model_groups import with_model_groups
from tests.helpers.runtime_backed import build_backed_app


@pytest.fixture
def app(base_env: None, engine: AsyncEngine) -> FastAPI:
    return build_backed_app(
        with_model_groups(make_runtime_config(), ["mkt", "ecom"]), engine=engine
    )


@asynccontextmanager
async def _signed_in(
    app: FastAPI, pg_url: str, username: str, roles: list[str]
) -> AsyncGenerator[httpx.AsyncClient]:
    async with make_client(app) as client:
        await register_and_login(client, username=username, email=f"{username}@example.com")
        await set_roles_in_db(pg_url, f"{username}@example.com", roles)
        yield client


@pytest.fixture
async def root(app: FastAPI, pg_url: str) -> AsyncGenerator[httpx.AsyncClient]:
    async with _signed_in(app, pg_url, "root", ["root"]) as client:
        yield client


@pytest.fixture
async def member_id(app: FastAPI, pg_url: str) -> str:
    async with make_client(app) as client:
        return await register_and_login(client, username="member", email="member@example.com")


async def _group_listed(root: httpx.AsyncClient, user_id: str) -> str | None:
    page = await root.get("/users")
    assert page.status_code == 200, page.text
    (found,) = [one for one in page.json()["items"] if one["id"] == user_id]
    return found["modelGroup"]


async def test_root_puts_a_user_in_a_group_and_back_in_the_default_group(
    root: httpx.AsyncClient, member_id: str
) -> None:
    assert await _group_listed(root, member_id) is None

    picked = await root.put(f"/users/{member_id}/model-group", json={"modelGroup": "ecom"})
    assert picked.status_code == 200, picked.text
    assert picked.json()["user"]["modelGroup"] == "ecom"
    assert await _group_listed(root, member_id) == "ecom"

    cleared = await root.put(f"/users/{member_id}/model-group", json={"modelGroup": None})
    assert cleared.status_code == 200, cleared.text
    assert await _group_listed(root, member_id) is None


async def test_an_admin_cannot_change_groups(app: FastAPI, pg_url: str, member_id: str) -> None:
    async with _signed_in(app, pg_url, "admin", ["admin"]) as admin:
        put = await admin.put(f"/users/{member_id}/model-group", json={"modelGroup": "mkt"})
        patched = await admin.patch(f"/users/{member_id}", json={"modelGroup": "mkt"})

    assert put.status_code == 403, put.text
    assert patched.status_code == 422, "改用户的接口不收配置组"


async def test_a_group_outside_the_config_is_refused_and_nothing_changes(
    root: httpx.AsyncClient, member_id: str
) -> None:
    assert (
        await root.put(f"/users/{member_id}/model-group", json={"modelGroup": "mkt"})
    ).status_code == 200

    refused = await root.put(f"/users/{member_id}/model-group", json={"modelGroup": "sales"})
    unspecified = await root.put(f"/users/{member_id}/model-group", json={})

    assert refused.status_code == 422, refused.text
    assert "sales" in refused.json()["detail"]
    assert "mkt、ecom" in refused.json()["detail"], "说明里列出可选的组"
    assert unspecified.status_code == 422, "不给 modelGroup 不当作清空"
    assert await _group_listed(root, member_id) == "mkt"


async def test_an_unknown_user_is_404(root: httpx.AsyncClient) -> None:
    response = await root.put(
        "/users/00000000-0000-0000-0000-000000000000/model-group", json={"modelGroup": "mkt"}
    )

    assert response.status_code == 404, response.text
