"""配置页管理接口转发时保留路径分段，以及未给字段与显式清空的区别；带操作人的答复整份只查一次显示名，
补到每个操作人字段上，查不到的人为 null，失败的答复原样交回、不查名字。"""

from __future__ import annotations

import json
import uuid
from collections.abc import AsyncGenerator, Collection, Mapping
from datetime import UTC, datetime
from typing import Any

import httpx
import pytest
from agent_runtime.client import RuntimeClient
from agent_runtime.config.agent_config.config import AgentConfig
from agent_runtime.config.agent_config.schemas import AgentDetailOut, AgentDraftOut
from agent_runtime.config.skills.schemas import SkillOut, SkillsOut
from fastapi import FastAPI

from iclip.domains.agent_config.api import create_agent_config_router
from iclip.domains.identity.public import Principal
from iclip.domains.model_providers.api import create_model_providers_router
from iclip.domains.skills.api import create_skills_router
from tests.helpers.app import app_with_principal, make_client

KEY = "runtime-admin-relay-test-key-0123456789"
ROOT = uuid.uuid4()
SKILL = uuid.UUID("00000000-0000-0000-0000-0000000000a1")
PROVIDER = uuid.UUID("00000000-0000-0000-0000-0000000000b2")
ALICE = uuid.UUID("00000000-0000-0000-0000-00000000a11c")
BOB = uuid.UUID("00000000-0000-0000-0000-000000000b0b")
GONE = uuid.UUID("00000000-0000-0000-0000-00000000dead")
NOW = datetime(2026, 11, 1, tzinfo=UTC)


class Runtime:
    """假的运行时服务：记下收到的请求，交回预先放好的答复（默认空的成功答复）。"""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.answer = httpx.Response(200, json={})

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.answer


class Names:
    """假的 identity：记下每次查了哪些 id；``GONE`` 不在本系统。"""

    def __init__(self) -> None:
        self.calls: list[set[uuid.UUID]] = []

    async def __call__(self, user_ids: Collection[uuid.UUID], /) -> Mapping[uuid.UUID, str]:
        self.calls.append(set(user_ids))
        known = {ALICE: "爱丽丝", BOB: "鲍勃"}
        return {one: known[one] for one in user_ids if one in known}


@pytest.fixture
def runtime() -> Runtime:
    return Runtime()


@pytest.fixture
def names() -> Names:
    return Names()


@pytest.fixture
async def client(runtime: Runtime, names: Names) -> AsyncGenerator[httpx.AsyncClient]:
    root = Principal(
        kind="user",
        user_id=ROOT,
        permissions=frozenset({"agent:manage", "model:manage"}),
        audit_label="root",
    )
    app: FastAPI = app_with_principal(root)
    async with RuntimeClient(
        "http://runtime.test", KEY, transport=httpx.MockTransport(runtime)
    ) as runtime_client:
        app.include_router(create_skills_router(runtime_client, names))
        app.include_router(create_model_providers_router(runtime_client))
        app.include_router(create_agent_config_router(runtime_client, names))
        async with make_client(app) as http:
            yield http


def skill(name: str, created_by: uuid.UUID) -> SkillOut:
    return SkillOut(
        id=uuid.uuid4(),
        name=name,
        display_name=name,
        description="",
        status="active",
        latest_version_id=None,
        latest_version=None,
        has_unpublished_changes=True,
        created_by=created_by,
        created_at=NOW,
        updated_at=NOW,
    )


def wire(model: Any) -> dict[str, Any]:
    return model.model_dump(mode="json", by_alias=True)


async def test_path_parameters_are_forwarded_segment_by_segment(
    client: httpx.AsyncClient, runtime: Runtime
) -> None:
    await client.get(f"/skills/{SKILL}/draft/files/references/sub/指南 1.md")
    await client.get(f"/skills/{SKILL}/draft/files/references/%2E%2E/SKILL.md")

    first, second = runtime.requests
    assert first.url.raw_path.decode() == (
        f"/v1/admin/skills/{SKILL}/draft/files/references/sub/%E6%8C%87%E5%8D%97%201.md"
    )
    # 点段转义着转出，交给运行时按非法路径判，不在半路被规范化成别的路由。
    assert second.url.raw_path.decode() == (
        f"/v1/admin/skills/{SKILL}/draft/files/references/%2E%2E/SKILL.md"
    )


async def test_an_update_forwards_only_the_fields_it_was_given(
    client: httpx.AsyncClient, runtime: Runtime
) -> None:
    """有的更新按「给没给」区分不动与清空：只给了 ``enabled``，就只转 ``enabled``。"""

    await client.patch(
        f"/model-providers/{PROVIDER}/models/llm/qwen/qwen-max", json={"enabled": False}
    )
    await client.patch(
        f"/model-providers/{PROVIDER}/models/llm/qwen/qwen-max", json={"contextSize": None}
    )

    first, second = runtime.requests
    assert first.url.path == f"/v1/admin/model-providers/{PROVIDER}/models/llm/qwen/qwen-max"
    assert json.loads(first.read()) == {"enabled": False}
    assert json.loads(second.read()) == {"contextSize": None}


async def test_a_list_looks_up_every_actor_once_and_names_each_item(
    client: httpx.AsyncClient, runtime: Runtime, names: Names
) -> None:
    items = [skill("a", ALICE), skill("b", BOB), skill("c", ALICE), skill("d", GONE)]
    runtime.answer = httpx.Response(200, json=wire(SkillsOut(items=items)))

    listed = await client.get("/skills")

    assert listed.status_code == 200, listed.text
    assert names.calls == [{ALICE, BOB, GONE}]
    assert [(one["createdBy"], one["createdByName"]) for one in listed.json()["items"]] == [
        (str(ALICE), "爱丽丝"),
        (str(BOB), "鲍勃"),
        (str(ALICE), "爱丽丝"),
        (str(GONE), None),
    ]
    # 别的字段照运行时的原样。
    assert [
        {k: v for k, v in one.items() if k != "createdByName"} for one in listed.json()["items"]
    ] == [wire(one) for one in items]


async def test_a_detail_names_its_creator_and_the_drafts_editor_in_one_lookup(
    client: httpx.AsyncClient, runtime: Runtime, names: Names
) -> None:
    """配置文档里插件参数的同名键是用户写的内容，不补名字、原样交回。"""

    config = AgentConfig.model_validate(
        {
            "schema_version": 1,
            "tools": [
                {
                    "type": "cap",
                    "toolset": "notes",
                    "enabled": True,
                    "parameters": {"created_by": str(ALICE), "createdBy": str(BOB)},
                }
            ],
        }
    )
    detail = AgentDetailOut(
        id="director",
        name="导演",
        description="",
        status="active",
        listed=False,
        sort_order=0,
        active_version=None,
        has_unpublished_changes=True,
        has_subagents=False,
        is_subagent=False,
        created_by=ALICE,
        created_at=NOW,
        updated_at=NOW,
        draft=AgentDraftOut(
            config=config,
            skill_ids=[],
            base_version_id=None,
            lock_version=0,
            updated_by=BOB,
            updated_at=NOW,
        ),
        used_by=[],
    )
    runtime.answer = httpx.Response(201, json=wire(detail))

    created = await client.post("/agents", json={"id": "director", "name": "导演"})

    assert created.status_code == 201, created.text
    assert names.calls == [{ALICE, BOB}]
    body = created.json()
    assert (body["createdByName"], body["draft"]["updatedByName"]) == ("爱丽丝", "鲍勃")
    assert body["draft"]["config"] == wire(detail)["draft"]["config"]


async def test_a_failed_answer_is_relayed_unchanged_without_a_lookup(
    client: httpx.AsyncClient, runtime: Runtime, names: Names
) -> None:
    runtime.answer = httpx.Response(
        404,
        content=b'{"detail":"agent \\u4e0d\\u5b58\\u5728"}',
        headers={"content-type": "application/json"},
    )

    missing = await client.get("/agents/ghost")

    assert missing.status_code == 404
    assert missing.content == b'{"detail":"agent \\u4e0d\\u5b58\\u5728"}'
    assert names.calls == []
