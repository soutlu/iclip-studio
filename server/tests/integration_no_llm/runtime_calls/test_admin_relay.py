"""配置页管理接口经后端转给真实的运行时 app：后端答的与直接问运行时答的逐字节相同。"""

from __future__ import annotations

from collections.abc import AsyncGenerator

import httpx
import pytest
from fastapi import FastAPI

from tests.helpers.auth import register_and_login, set_roles_in_db
from tests.helpers.runtime_backed import RUNTIME_APP_KEY, RUNTIME_URL


@pytest.fixture
async def root(client: httpx.AsyncClient, migrated_pg: str) -> str:
    user_id = await register_and_login(client, username="root", email="root@example.com")
    await set_roles_in_db(migrated_pg, "root@example.com", ["root"])
    return user_id


@pytest.fixture
async def direct(app: FastAPI, root: str) -> AsyncGenerator[httpx.AsyncClient]:
    """绕过后端、以应用 ``video`` 的身份代 root 直接问运行时；路径相对 ``/v1/admin``。"""

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app.state.runtime_service),
        base_url=f"{RUNTIME_URL}/v1/admin",
        headers={"Authorization": f"Bearer {RUNTIME_APP_KEY}", "X-End-User": root},
    ) as client:
        yield client


def answer_of(response: httpx.Response) -> tuple[int, bytes, str | None]:
    return response.status_code, response.content, response.headers.get("content-type")


async def test_a_404_is_the_runtimes_answer_unchanged(
    client: httpx.AsyncClient, direct: httpx.AsyncClient
) -> None:
    path = "/skills/00000000-0000-0000-0000-0000000000a1"

    relayed = await client.get(path)

    assert relayed.status_code == 404
    assert answer_of(relayed) == answer_of(await direct.get(path))


async def test_a_blocked_publish_carries_the_runtimes_problem_list_unchanged(
    client: httpx.AsyncClient, direct: httpx.AsyncClient
) -> None:
    created = await client.post("/agents", json={"id": "director", "name": "导演"})
    assert created.status_code == 201, created.text
    saved = await client.put(
        "/agents/director/draft",
        json={
            "config": {
                "schema_version": 1,
                "instructions": "",
                "model": {"provider": "nowhere", "name": "nothing"},
                "tools": [],
                "subagents": [],
            },
            "skillIds": [],
            "lockVersion": created.json()["draft"]["lockVersion"],
        },
    )
    assert saved.status_code == 200, saved.text
    body = {"lockVersion": saved.json()["draft"]["lockVersion"]}

    relayed = await client.post("/agents/director/versions", json=body)

    assert relayed.status_code == 422
    assert relayed.json()["problems"]
    assert answer_of(relayed) == answer_of(
        await direct.post("/agents/director/versions", json=body)
    )


async def test_an_export_carries_the_runtimes_filename(
    client: httpx.AsyncClient, direct: httpx.AsyncClient
) -> None:
    created = await client.post(
        "/skills", json={"name": "pdf-tools", "displayName": "PDF 工具", "description": "处理 PDF"}
    )
    assert created.status_code == 201, created.text
    base = f"/skills/{created.json()['id']}"
    assert (await client.post(f"{base}/versions", json={})).status_code == 201

    relayed = await client.get(f"{base}/export")
    straight = await direct.get(f"{base}/export")

    assert relayed.status_code == 200
    assert relayed.headers["content-type"] == straight.headers["content-type"] == "application/zip"
    assert relayed.headers["content-disposition"] == straight.headers["content-disposition"]

    imported = await client.post(
        "/skills/import",
        params={"dryRun": "true"},
        files={"file": ("pdf-tools.zip", relayed.content, "application/zip")},
    )
    checked = await direct.post(
        "/skills/import",
        params={"dryRun": "true"},
        files={"file": ("pdf-tools.zip", relayed.content, "application/zip")},
    )
    assert imported.status_code == 200, imported.text
    assert answer_of(imported) == answer_of(checked)
