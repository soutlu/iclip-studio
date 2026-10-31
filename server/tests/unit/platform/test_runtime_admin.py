"""配置页管理接口转发时保留路径分段，以及未给字段与显式清空的区别。"""

from __future__ import annotations

import json
import uuid
from collections.abc import AsyncGenerator

import httpx
import pytest
from agent_runtime.client import RuntimeClient
from fastapi import FastAPI

from iclip.domains.identity.public import Principal
from iclip.domains.model_providers.api import create_model_providers_router
from iclip.domains.skills.api import create_skills_router
from tests.helpers.app import app_with_principal, make_client

KEY = "runtime-admin-relay-test-key-0123456789"
ROOT = uuid.uuid4()
SKILL = uuid.UUID("00000000-0000-0000-0000-0000000000a1")
PROVIDER = uuid.UUID("00000000-0000-0000-0000-0000000000b2")


class Runtime:
    """假的运行时服务：记下收到的请求，交回空的成功答复。"""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return httpx.Response(200, json={})


@pytest.fixture
def runtime() -> Runtime:
    return Runtime()


@pytest.fixture
async def client(runtime: Runtime) -> AsyncGenerator[httpx.AsyncClient]:
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
        app.include_router(create_skills_router(runtime_client))
        app.include_router(create_model_providers_router(runtime_client))
        async with make_client(app) as http:
            yield http


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
