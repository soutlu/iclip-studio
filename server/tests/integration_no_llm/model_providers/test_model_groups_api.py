"""配置页的密钥按配置组：组名列表来自部署配置，密钥的组名透传给运行时，不在配置里的组名 422。"""

from __future__ import annotations

from collections.abc import AsyncGenerator
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncEngine

from tests.helpers.app import make_client, make_runtime_config
from tests.helpers.auth import register_and_login, set_roles_in_db
from tests.helpers.model_groups import with_model_groups
from tests.helpers.model_providers import GOOD_KEY, KeyCheckingProbe, connect_bailian
from tests.helpers.runtime_backed import build_backed_app


@pytest.fixture
def app(base_env: None, engine: AsyncEngine) -> FastAPI:
    config = with_model_groups(make_runtime_config(), {"mkt": [101], "ecom": [102]})
    return build_backed_app(config, engine=engine, credential_probe=KeyCheckingProbe({GOOD_KEY}))


@pytest.fixture
async def root(app: FastAPI, migrated_pg: str) -> AsyncGenerator[httpx.AsyncClient]:
    async with make_client(app) as client:
        await register_and_login(client, username="root", email="root@example.com")
        await set_roles_in_db(migrated_pg, "root@example.com", ["root"])
        yield client


async def credentials_of(client: httpx.AsyncClient, provider_id: str) -> list[dict[str, Any]]:
    response = await client.get("/model-providers")
    assert response.status_code == 200, response.text
    (found,) = [one for one in response.json()["providers"] if one["id"] == provider_id]
    return found["credentials"]


async def test_the_groups_are_listed_in_config_order(root: httpx.AsyncClient) -> None:
    response = await root.get("/model-providers/groups")

    assert response.status_code == 200, response.text
    assert response.json() == {"groups": ["mkt", "ecom"]}


async def test_a_credentials_group_is_kept_changed_and_cleared_through_the_runtime(
    root: httpx.AsyncClient,
) -> None:
    provider = await connect_bailian(root)
    base = f"/model-providers/{provider['id']}/credentials"

    created = await root.post(
        base, json={"name": "市场部", "fields": {"api_key": GOOD_KEY}, "modelGroup": "mkt"}
    )
    assert created.status_code == 201, created.text
    assert created.json()["modelGroup"] == "mkt"
    path = f"{base}/{created.json()['id']}"

    renamed = await root.patch(path, json={"name": "市场一部"})
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["modelGroup"] == "mkt", "不给 modelGroup 就不动"

    moved = await root.patch(path, json={"modelGroup": "ecom"})
    assert moved.status_code == 200, moved.text
    assert [one["modelGroup"] for one in await credentials_of(root, provider["id"])] == ["ecom"]

    cleared = await root.patch(path, json={"modelGroup": None})
    assert cleared.status_code == 200, cleared.text
    assert [one["modelGroup"] for one in await credentials_of(root, provider["id"])] == [None]


async def test_a_credential_without_a_group_is_in_the_default_group(
    root: httpx.AsyncClient,
) -> None:
    provider = await connect_bailian(root)

    created = await root.post(
        f"/model-providers/{provider['id']}/credentials",
        json={"name": "主账号", "fields": {"api_key": GOOD_KEY}},
    )

    assert created.status_code == 201, created.text
    assert created.json()["modelGroup"] is None


async def test_a_group_that_is_not_configured_is_refused_and_nothing_changes(
    root: httpx.AsyncClient,
) -> None:
    provider = await connect_bailian(root)
    base = f"/model-providers/{provider['id']}/credentials"
    kept = await root.post(
        base, json={"name": "市场部", "fields": {"api_key": GOOD_KEY}, "modelGroup": "mkt"}
    )
    assert kept.status_code == 201, kept.text

    refused_create = await root.post(
        base, json={"name": "销售部", "fields": {"api_key": GOOD_KEY}, "modelGroup": "sales"}
    )
    refused_update = await root.patch(f"{base}/{kept.json()['id']}", json={"modelGroup": "sales"})

    for refused in (refused_create, refused_update):
        assert refused.status_code == 422, refused.text
        assert "sales" in refused.json()["detail"]
    assert [
        (one["name"], one["modelGroup"]) for one in await credentials_of(root, provider["id"])
    ] == [("市场部", "mkt")]
