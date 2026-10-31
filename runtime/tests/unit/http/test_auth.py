"""应用密钥鉴权：``/v1`` 要认得的应用密钥（401），``/v1/admin`` 另要管理权限（403），管理接口的写操作要
``X-End-User``（422）；健康检查不鉴权。用到的路由都在碰库之前就答复，engine 建出来但从不连接。"""

from __future__ import annotations

import base64
from collections.abc import AsyncGenerator, Mapping
from dataclasses import dataclass
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from pydantic_ai.capabilities import Capability

from agent_runtime.http.app import create_app
from agent_runtime.plugins.base import CapPlugin
from agent_runtime.settings import AgentRunsSection, CompactionSection, ResolvedApp, RuntimeSettings
from agent_runtime.transcript.display import DisplayFn, ToolDisplayEntry

ADMIN_KEY = "admin-app-key-0123456789-0123456789"
READER_KEY = "reader-app-key-0123456789-012345678"
END_USER = "6f1d8a4e-2b7c-4e0a-9d51-3c2f7e8b9a10"


@dataclass
class LimitedPlugin(CapPlugin[Any]):
    """测试插件：带一个参数。"""

    label = "限量"
    summary = "测试用。"

    @classmethod
    def get_serialization_name(cls) -> str:
        return "limited"

    @classmethod
    def from_spec(cls, *, limit: int = 10) -> Capability[Any]:
        return Capability[Any](id="limited", instructions=f"最多 {limit} 条。")

    @classmethod
    def display_table(cls) -> Mapping[str, DisplayFn | ToolDisplayEntry]:
        return {}


@pytest.fixture
def app() -> FastAPI:
    settings = RuntimeSettings(
        database_url="postgresql+asyncpg://nobody:nothing@127.0.0.1:1/never",
        credential_encryption_keys=(base64.urlsafe_b64encode(b"x" * 32).decode(),),
        apps=(
            ResolvedApp(id="bff", key=ADMIN_KEY, admin=True),
            ResolvedApp(id="reader", key=READER_KEY, admin=False),
        ),
        agent_runs=AgentRunsSection(),
        compaction=CompactionSection(),
        log_level="WARNING",
        log_format="console",
    )
    return create_app(settings, plugins={"limited": LimitedPlugin})


@pytest.fixture
async def client(app: FastAPI) -> AsyncGenerator[httpx.AsyncClient]:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://runtime.test"
    ) as c:
        yield c


def bearer(key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {key}"}


async def test_health_needs_no_key(client: httpx.AsyncClient) -> None:
    response = await client.get("/healthz")

    assert (response.status_code, response.json()) == (200, {"status": "ok"})


async def test_an_admin_app_reads_the_plugins_it_was_given(client: httpx.AsyncClient) -> None:
    response = await client.get("/v1/admin/agents/plugins", headers=bearer(ADMIN_KEY))

    assert response.status_code == 200, response.text
    assert [one["name"] for one in response.json()["items"]] == ["limited"]


@pytest.mark.parametrize(
    "headers",
    [
        {},
        bearer("wrong-key-0123456789-0123456789-abcd"),
        bearer(ADMIN_KEY + "x"),
        {"Authorization": f"Basic {ADMIN_KEY}"},
        {"Authorization": ADMIN_KEY},
    ],
)
async def test_a_missing_or_unknown_key_is_401_in_the_error_envelope(
    client: httpx.AsyncClient, headers: dict[str, str]
) -> None:
    response = await client.get("/v1/admin/agents/plugins", headers=headers)

    assert response.status_code == 401
    assert set(response.json()) == {"detail"}


async def test_the_key_is_checked_before_the_request_is_validated(
    client: httpx.AsyncClient,
) -> None:
    response = await client.post("/v1/admin/agents", json={})

    assert response.status_code == 401


async def test_an_app_without_admin_is_403_on_admin_routes(client: httpx.AsyncClient) -> None:
    for method, url in (
        ("GET", "/v1/admin/agents/plugins"),
        ("GET", "/v1/admin/skills"),
        ("POST", "/v1/admin/model-providers"),
    ):
        response = await client.request(
            method, url, headers={**bearer(READER_KEY), "X-End-User": END_USER}, json={}
        )
        assert response.status_code == 403, (method, url)
        assert set(response.json()) == {"detail"}


@pytest.mark.parametrize("end_user", [None, "not-a-uuid"])
async def test_a_write_needs_an_end_user_uuid(
    client: httpx.AsyncClient, end_user: str | None
) -> None:
    headers = (
        bearer(ADMIN_KEY) if end_user is None else {**bearer(ADMIN_KEY), "X-End-User": end_user}
    )

    response = await client.post(
        "/v1/admin/agents", json={"id": "director", "name": "导演"}, headers=headers
    )

    assert response.status_code == 422
    assert response.json()["detail"].startswith("X-End-User: ")


OWNER_SCOPED = {
    ("post", "/v1/sessions/{session_id}:fork"),
    ("post", "/v1/sessions/{session_id}/files:copy"),
    ("post", "/v1/sessions/{session_id}/prompts"),
    ("get", "/v1/sessions/{session_id}/files"),
    ("get", "/v1/sessions/{session_id}/files/{path}"),
    ("put", "/v1/sessions/{session_id}/files/{path}"),
    ("post", "/v1/sessions/{session_id}/materials"),
    ("get", "/v1/sessions/{session_id}/materials"),
}
"""会话接口里要会话属主的那几个：算命名空间、记新消息的属主，或给分叉与拷文件的目标定属主。"""


def _end_user_headers(operation: Mapping[str, Any]) -> list[bool]:
    return [
        one["required"]
        for one in operation.get("parameters", [])
        if one["in"] == "header" and one["name"] == "X-End-User"
    ]


def test_every_v1_operation_declares_the_app_key_and_every_admin_write_the_end_user(
    app: FastAPI,
) -> None:
    paths = app.openapi()["paths"]

    assert "security" not in paths["/healthz"]["get"]
    operations = [
        (method, path, operation)
        for path, item in paths.items()
        if path.startswith("/v1/")
        for method, operation in item.items()
    ]
    assert len(operations) >= 60
    owner_scoped: set[tuple[str, str]] = set()
    for method, path, operation in operations:
        assert operation["security"] == [{"AppKey": []}], (method, path)
        end_user = _end_user_headers(operation)
        if not path.startswith("/v1/admin/"):
            assert end_user in ([], [True]), (method, path)
            if end_user:
                owner_scoped.add((method, path))
        elif method == "get":
            assert end_user == [], (method, path)
        else:
            assert end_user == [True], (method, path)
    assert owner_scoped == OWNER_SCOPED
