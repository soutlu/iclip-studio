"""Agent 配置端点：只有 ``agent:manage``（root）能用，editor 一律 403；发布被拦下时 422 带结构化的问题清单，
lockVersion 对不上 409，导出给 YAML、导入用 multipart 分两步。"""

from __future__ import annotations

import uuid
from typing import Any

import httpx
import yaml
from fastapi import FastAPI

from tests.helpers.auth import login_as_editor, register_and_login, set_roles_in_db
from tests.helpers.runtime_backed import runtime_admin


async def login_as_root(client: httpx.AsyncClient, pg_url: str) -> None:
    await register_and_login(client, username="root", email="root@example.com")
    await set_roles_in_db(pg_url, "root@example.com", ["root"])


def package_upload(data: bytes) -> dict[str, tuple[str, bytes, str]]:
    return {"file": ("director.yaml", data, "application/yaml")}


async def test_editor_is_forbidden_everywhere(client: httpx.AsyncClient, migrated_pg: str) -> None:
    await login_as_editor(client, migrated_pg)

    calls: tuple[tuple[str, str, dict[str, Any]], ...] = (
        ("GET", "/agents", {}),
        ("GET", "/agents/plugins", {}),
        ("GET", "/agents/model-options", {}),
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


async def test_admin_cannot_reach_the_config_page(
    client: httpx.AsyncClient, migrated_pg: str
) -> None:
    """admin 有 root 的其余权限，唯独没有 ``agent:manage`` 与 ``model:manage``：配置页的各组端点都是 403。"""

    await register_and_login(client, username="ada", email="ada@example.com")
    await set_roles_in_db(migrated_pg, "ada@example.com", ["admin"])

    for method, url in (
        ("GET", "/agents"),
        ("GET", "/skills"),
        ("GET", "/mcp-servers"),
        ("GET", "/model-providers"),
        ("POST", "/agents/director/previews"),
    ):
        assert (await client.request(method, url)).status_code == 403, (method, url)


async def test_root_lists_the_plugins_from_the_registry(
    client: httpx.AsyncClient, migrated_pg: str
) -> None:
    """不需要任何配置也登记的三个插件都在；参数是插件 from_spec 签名写成的 JSON Schema。"""

    await login_as_root(client, migrated_pg)

    listed = await client.get("/agents/plugins")

    assert listed.status_code == 200, listed.text
    plugins = {plugin["name"]: plugin for plugin in listed.json()["items"]}
    assert {"workspace", "iclip_studio", "video_shots"} <= set(plugins)
    workspace = plugins["workspace"]
    assert (workspace["label"], workspace["requires"]) == ("工作区文件", [])
    assert workspace["description"]
    assert workspace["parameters"]["type"] == "object"
    assert workspace["parameters"]["properties"] == {}
    assert workspace["parameters"]["additionalProperties"] is False
    assert plugins["video_shots"]["requires"] == ["workspace"]


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


async def save_subagents(client: httpx.AsyncClient, agent_id: str, subagents: list[str]) -> None:
    detail = (await client.get(f"/agents/{agent_id}")).json()
    saved = await client.put(
        f"/agents/{agent_id}/draft",
        json={
            "config": {"schema_version": 1, "subagents": [{"agent": one} for one in subagents]},
            "skillIds": [],
            "lockVersion": detail["draft"]["lockVersion"],
        },
    )
    assert saved.status_code == 200, saved.text


async def test_agents_can_start_listed_and_show_their_subagent_roles(
    client: httpx.AsyncClient, migrated_pg: str
) -> None:
    """``listed`` 在建的时候就能给；列表每项说它有没有子 agent、是不是别人的子 agent，详情也一样。"""

    await login_as_root(client, migrated_pg)
    listed = await client.post("/agents", json={"id": "helper", "name": "帮手", "listed": True})
    assert listed.status_code == 201, listed.text
    assert listed.json()["listed"] is True
    for agent_id in ("director", "loner"):
        assert (
            await client.post("/agents", json={"id": agent_id, "name": agent_id})
        ).status_code == 201
    assert (await client.get("/agents/loner")).json()["listed"] is False
    assert (
        await client.post("/agents", json={"id": "model-options", "name": "x"})
    ).status_code == 422

    await save_subagents(client, "director", ["helper"])

    items = {one["id"]: one for one in (await client.get("/agents")).json()["items"]}
    assert {key: (one["hasSubagents"], one["isSubagent"]) for key, one in items.items()} == {
        "director": (True, False),
        "helper": (False, True),
        "loner": (False, False),
    }
    assert items["helper"]["listed"] is True
    helper = (await client.get("/agents/helper")).json()
    assert (helper["hasSubagents"], helper["isSubagent"]) == (False, True)

    await save_subagents(client, "director", [])
    items = {one["id"]: one for one in (await client.get("/agents")).json()["items"]}
    assert (items["director"]["hasSubagents"], items["helper"]["isSubagent"]) == (False, False)


async def test_agent_answers_name_the_people_behind_the_ids(
    app: FastAPI, client: httpx.AsyncClient, migrated_pg: str
) -> None:
    """建的人与改草稿的人都带显示名（没设显示名时用用户名）；运行时记下的人在本系统里没有时为 null。"""

    author = await register_and_login(client, username="root", email="root@example.com")
    await set_roles_in_db(migrated_pg, "root@example.com", ["root"])
    stranger = str(uuid.uuid4())
    async with runtime_admin(app, end_user=stranger) as direct:
        ghost = await direct.post("/agents", json={"id": "ghost-made", "name": "无主"})
        assert ghost.status_code == 201, ghost.text

    created = await client.post("/agents", json={"id": "director", "name": "导演"})

    assert created.status_code == 201, created.text
    assert (created.json()["createdBy"], created.json()["createdByName"]) == (author, "root")
    assert created.json()["draft"]["updatedByName"] == "root"
    await save_subagents(client, "ghost-made", [])
    edited = (await client.get("/agents/ghost-made")).json()
    assert (edited["createdBy"], edited["createdByName"]) == (stranger, None)
    assert (edited["draft"]["updatedBy"], edited["draft"]["updatedByName"]) == (author, "root")
    items = {one["id"]: one for one in (await client.get("/agents")).json()["items"]}
    assert (items["director"]["createdByName"], items["ghost-made"]["createdByName"]) == (
        "root",
        None,
    )
    versions = await client.get("/agents/director/versions")
    assert versions.status_code == 200 and versions.json() == {"items": []}
