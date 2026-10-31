"""配置页管理接口转给运行时服务：请求按同一个子路径、带密钥与操作人转出，答复的状态码、正文与下载头原样交回。

运行时那一端是 ``httpx.MockTransport``：记下收到的请求，按用例给的答复答。"""

from __future__ import annotations

import json
import uuid
from collections.abc import AsyncGenerator, Callable

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
    """假的运行时服务：记下每个请求，答 ``answer`` 交回的答复。"""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.answer: Callable[[httpx.Request], httpx.Response] = lambda _request: httpx.Response(
            200, json={}
        )

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.answer(request)

    @property
    def last(self) -> httpx.Request:
        return self.requests[-1]


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


async def test_a_4xx_comes_back_with_the_same_status_body_and_type(
    client: httpx.AsyncClient, runtime: Runtime
) -> None:
    body = '{"detail":"标识已被占用","code":"taken"}'.encode()
    runtime.answer = lambda _request: httpx.Response(
        409, content=body, headers={"content-type": "application/json"}
    )

    answered = await client.post(
        "/skills", json={"name": "pdf-tools", "displayName": "PDF 工具", "description": "d"}
    )

    assert (answered.status_code, answered.content) == (409, body)
    assert answered.headers["content-type"] == "application/json"
    assert runtime.last.method == "POST"
    assert runtime.last.url.path == "/v1/admin/skills"
    assert runtime.last.headers["authorization"] == f"Bearer {KEY}"
    assert runtime.last.headers["x-end-user"] == str(ROOT)


async def test_an_export_brings_the_bytes_and_the_download_header(
    client: httpx.AsyncClient, runtime: Runtime
) -> None:
    archive = b"PK\x03\x04 not really a zip"
    disposition = 'attachment; filename="pdf-tools-v1.zip"'
    runtime.answer = lambda _request: httpx.Response(
        200,
        content=archive,
        headers={"content-type": "application/zip", "content-disposition": disposition},
    )
    version = uuid.uuid4()

    exported = await client.get(f"/skills/{SKILL}/export", params={"versionId": str(version)})

    assert (exported.status_code, exported.content) == (200, archive)
    assert exported.headers["content-type"] == "application/zip"
    assert exported.headers["content-disposition"] == disposition
    assert runtime.last.url.path == f"/v1/admin/skills/{SKILL}/export"
    assert runtime.last.url.params["versionId"] == str(version)


async def test_an_upload_is_forwarded_with_its_bytes_filename_and_dry_run(
    client: httpx.AsyncClient, runtime: Runtime
) -> None:
    data = b"PK\x03\x04 zip bytes \x00\xff"

    imported = await client.post(
        "/skills/import",
        params={"dryRun": "true"},
        files={"file": ("pdf-tools.zip", data, "application/zip")},
    )

    assert imported.status_code == 200
    forwarded = runtime.last
    assert forwarded.url.path == "/v1/admin/skills/import"
    assert forwarded.url.params["dryRun"] == "true"
    assert forwarded.headers["content-type"].startswith("multipart/form-data")
    content = forwarded.read()
    assert b'name="file"; filename="pdf-tools.zip"' in content
    assert data in content


async def test_a_204_comes_back_empty(client: httpx.AsyncClient, runtime: Runtime) -> None:
    runtime.answer = lambda _request: httpx.Response(204)

    deleted = await client.delete(
        f"/skills/{SKILL}/draft/files/references/a.md", params={"baseHash": "h"}
    )

    assert (deleted.status_code, deleted.content) == (204, b"")
    assert runtime.last.url.params["baseHash"] == "h"


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
