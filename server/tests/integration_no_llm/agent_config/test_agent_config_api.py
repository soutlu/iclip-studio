"""Agent 配置端点：只有 ``agent:manage``（root）能用，editor 一律 403；发布被拦下时 422 带结构化的问题清单，
lockVersion 对不上 409，导出给 YAML、导入用 multipart 分两步。"""

from __future__ import annotations

from typing import Any

import httpx
import yaml
from fastapi import FastAPI

from tests.helpers.auth import login_as_editor, register_and_login, set_roles_in_db


async def login_as_root(client: httpx.AsyncClient, pg_url: str) -> None:
    await register_and_login(client, username="root", email="root@example.com")
    await set_roles_in_db(pg_url, "root@example.com", ["root"])


def package_upload(data: bytes) -> dict[str, tuple[str, bytes, str]]:
    return {"file": ("director.yaml", data, "application/yaml")}


async def test_every_agents_operation_requires_exactly_agent_manage(app: FastAPI) -> None:
    operations = [
        (method, path, operation)
        for path, item in app.openapi()["paths"].items()
        if path == "/agents" or path.startswith("/agents/")
        for method, operation in item.items()
    ]

    assert len(operations) >= 14
    for method, path, operation in operations:
        scopes = {
            tuple(scopes)
            for requirement in operation["security"]
            for scopes in requirement.values()
        }
        assert scopes == {("agent:manage",)}, (method, path)


async def test_publish_documents_the_problem_list(app: FastAPI) -> None:
    operation = app.openapi()["paths"]["/agents/{agent_id}/versions"]["post"]

    schema = operation["responses"]["422"]["content"]["application/json"]["schema"]
    assert schema == {"$ref": "#/components/schemas/AgentPublishProblemsOut"}


async def test_editor_is_forbidden_everywhere(client: httpx.AsyncClient, migrated_pg: str) -> None:
    await login_as_editor(client, migrated_pg)

    calls: tuple[tuple[str, str, dict[str, Any]], ...] = (
        ("GET", "/agents", {}),
        ("POST", "/agents", {"json": {"id": "director", "name": "导演"}}),
        ("PUT", "/agents/order", {"json": {"ids": []}}),
        ("GET", "/agents/director", {}),
        ("PATCH", "/agents/director", {"json": {"name": "x"}}),
        (
            "PUT",
            "/agents/director/draft",
            {"json": {"config": {"schema_version": 1}, "skillIds": [], "lockVersion": 0}},
        ),
        ("POST", "/agents/director/versions", {"json": {"lockVersion": 0}}),
        ("GET", "/agents/director/versions", {}),
        ("POST", "/agents/director/archive", {}),
        ("GET", "/agents/director/export", {}),
        ("POST", "/agents/import", {"params": {"dryRun": "true"}, "files": package_upload(b"x")}),
    )
    for method, url, kwargs in calls:
        assert (await client.request(method, url, **kwargs)).status_code == 403, (method, url)


async def test_root_manages_an_agent_end_to_end(
    client: httpx.AsyncClient, migrated_pg: str
) -> None:
    await login_as_root(client, migrated_pg)

    created = await client.post(
        "/agents", json={"id": "director", "name": "导演", "description": "拍片子"}
    )
    assert created.status_code == 201, created.text
    agent = created.json()
    assert (agent["id"], agent["status"], agent["activeVersion"]) == ("director", "active", None)
    assert agent["draft"]["config"]["model"] is None
    assert agent["draft"]["lockVersion"] == 0 and agent["usedBy"] == []
    assert (
        await client.post("/agents", json={"id": "director", "name": "又一个"})
    ).status_code == 409
    assert (await client.post("/agents", json={"id": "Bad_Id", "name": "x"})).status_code == 422

    draft = {
        "config": {"schema_version": 1, "instructions": "你是导演", "tools": [], "subagents": []},
        "skillIds": [],
        "lockVersion": 0,
    }
    saved = await client.put("/agents/director/draft", json=draft)
    assert saved.status_code == 200, saved.text
    assert saved.json()["draft"]["lockVersion"] == 1
    stale = await client.put("/agents/director/draft", json=draft)
    assert stale.status_code == 409
    malformed = await client.put(
        "/agents/director/draft",
        json={**draft, "config": {"schema_version": 1, "colour": "red"}, "lockVersion": 1},
    )
    assert malformed.status_code == 422

    blocked = await client.post("/agents/director/versions", json={"lockVersion": 1})
    assert blocked.status_code == 422
    assert blocked.json()["problems"] == [{"path": "model", "message": "请选择模型"}]
    assert "model" in blocked.json()["detail"]

    assert (await client.get("/agents/director/export")).status_code == 404
    assert (await client.get("/agents/ghost")).status_code == 404

    listed = await client.get("/agents")
    assert [one["id"] for one in listed.json()["items"]] == ["director"]
    assert listed.json()["items"][0]["hasUnpublishedChanges"] is True

    package = yaml.safe_dump(
        {
            "format_version": "1.0.0",
            "entry": "helper",
            "agents": {"helper": {"name": "帮手", "config": {"schema_version": 1}}},
        },
        allow_unicode=True,
    ).encode()
    checked = await client.post(
        "/agents/import", params={"dryRun": "true"}, files=package_upload(package)
    )
    assert checked.status_code == 200, checked.text
    assert checked.json()["agents"] == [
        {"agentId": "helper", "name": "帮手", "action": "create", "problems": [], "warnings": []}
    ]
    assert (await client.get("/agents/helper")).status_code == 404
    imported = await client.post("/agents/import", files=package_upload(package))
    assert imported.status_code == 200, imported.text
    assert (await client.get("/agents/helper")).status_code == 200
    broken = await client.post("/agents/import", files=package_upload(b"agents: ["))
    assert broken.status_code == 422

    archived = await client.post("/agents/helper/archive")
    assert archived.status_code == 200 and archived.json()["status"] == "archived"
