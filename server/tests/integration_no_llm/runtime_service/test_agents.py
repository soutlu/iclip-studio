"""运行时服务的 agent 配置管理接口：插件列表与插件校验都只看交给服务的插件登记表；建、存草稿、发布被拦下
时带问题清单、发布、导出 YAML、导入先检查，保留的标识不能用。"""

from __future__ import annotations

import uuid
from typing import Any

import httpx
import yaml

from tests.helpers.model_providers import GOOD_KEY


def package_upload(data: bytes) -> dict[str, tuple[str, bytes, str]]:
    return {"file": ("director.yaml", data, "application/yaml")}


def config(*tools: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "instructions": "你是导演",
        "model": {"provider": "bailian-main", "name": "qwen3.8-flash"},
        "tools": list(tools),
        "subagents": [],
    }


def plugin(name: str, **parameters: Any) -> dict[str, Any]:
    return {"type": "cap", "toolset": name, "enabled": True, "parameters": parameters}


async def connect_provider(admin: httpx.AsyncClient) -> None:
    provider = await admin.post(
        "/model-providers", json={"name": "bailian-main", "provider": "bailian", "label": "百炼"}
    )
    assert provider.status_code == 201, provider.text
    credential = await admin.post(
        f"/model-providers/{provider.json()['id']}/credentials",
        json={"name": "主账号", "fields": {"api_key": GOOD_KEY}},
    )
    assert credential.status_code == 201, credential.text


async def save_draft(
    admin: httpx.AsyncClient, agent_id: str, body: dict[str, Any], lock_version: int
) -> int:
    saved = await admin.put(
        f"/agents/{agent_id}/draft",
        json={"config": body, "skillIds": [], "lockVersion": lock_version},
    )
    assert saved.status_code == 200, saved.text
    return int(saved.json()["draft"]["lockVersion"])


async def test_plugins_come_from_the_injected_registry(admin: httpx.AsyncClient) -> None:
    listed = await admin.get("/agents/plugins")

    assert listed.status_code == 200, listed.text
    (only,) = listed.json()["items"]
    assert (only["name"], only["label"], only["requires"]) == ("limited", "限量", [])
    assert only["parameters"]["properties"]["limit"]["type"] == "integer"


async def test_publish_checks_plugins_against_the_injected_registry(
    admin: httpx.AsyncClient,
) -> None:
    await connect_provider(admin)
    assert (await admin.post("/agents", json={"id": "director", "name": "导演"})).status_code == 201

    lock = await save_draft(admin, "director", config(plugin("workspace")), 0)
    unknown = await admin.post("/agents/director/versions", json={"lockVersion": lock})
    assert unknown.status_code == 422
    assert [one["path"] for one in unknown.json()["problems"]] == ["tools[0]"]
    assert "workspace" in unknown.json()["problems"][0]["message"]

    lock = await save_draft(admin, "director", config(plugin("limited", limit="many")), lock)
    bad_parameter = await admin.post("/agents/director/versions", json={"lockVersion": lock})
    assert bad_parameter.status_code == 422
    assert [one["path"] for one in bad_parameter.json()["problems"]] == [
        "tools[0].parameters.limit"
    ]

    lock = await save_draft(admin, "director", config(plugin("limited", limit=3)), lock)
    published = await admin.post("/agents/director/versions", json={"lockVersion": lock})
    assert published.status_code == 201, published.text


async def test_admin_manages_an_agent_end_to_end(
    admin: httpx.AsyncClient, actor: uuid.UUID
) -> None:
    await connect_provider(admin)
    created = await admin.post(
        "/agents", json={"id": "director", "name": "导演", "description": "拍片子"}
    )
    assert created.status_code == 201, created.text
    assert (created.json()["status"], created.json()["activeVersion"]) == ("active", None)
    assert (
        await admin.post("/agents", json={"id": "director", "name": "又一个"})
    ).status_code == 409
    for reserved in ("plugins", "order", "import"):
        assert (
            await admin.post("/agents", json={"id": reserved, "name": "x"})
        ).status_code == 422, reserved

    blocked = await admin.post("/agents/director/versions", json={"lockVersion": 0})
    assert blocked.status_code == 422
    assert blocked.json()["problems"] == [{"path": "model", "message": "请选择模型"}]
    assert "model" in blocked.json()["detail"]
    assert (await admin.get("/agents/director/export")).status_code == 404

    lock = await save_draft(admin, "director", config(), 0)
    assert (
        await admin.put(
            "/agents/director/draft", json={"config": config(), "skillIds": [], "lockVersion": 0}
        )
    ).status_code == 409
    published = await admin.post(
        "/agents/director/versions", json={"lockVersion": lock, "note": "第一版"}
    )
    assert published.status_code == 201, published.text
    assert (published.json()["version"], published.json()["createdBy"]) == (1, str(actor))

    listed = (await admin.get("/agents")).json()["items"]
    assert [(one["id"], one["activeVersion"]["version"]) for one in listed] == [("director", 1)]
    versions = (await admin.get("/agents/director/versions")).json()["items"]
    assert [one["id"] for one in versions] == [published.json()["id"]]

    exported = await admin.get("/agents/director/export")
    assert exported.status_code == 200
    assert exported.headers["content-type"].startswith("application/yaml")
    package = yaml.safe_load(exported.content)
    assert package["entry"] == "director"
    assert package["agents"]["director"]["config"]["instructions"] == "你是导演"

    checked = await admin.post(
        "/agents/import", params={"dryRun": "true"}, files=package_upload(exported.content)
    )
    assert checked.status_code == 200, checked.text
    assert [(one["agentId"], one["action"]) for one in checked.json()["agents"]] == [
        ("director", "overwrite")
    ]
    broken = await admin.post("/agents/import", files=package_upload(b"agents: ["))
    assert broken.status_code == 422

    archived = await admin.post("/agents/director/archive")
    assert archived.json()["status"] == "archived"
    assert (await admin.post("/agents/director/unarchive")).json()["status"] == "active"
