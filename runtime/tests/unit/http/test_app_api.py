"""给应用的会话接口里不碰库就答复的那部分：缺属主、形状不对、页大小越界、非规范路径都在进服务之前拒；
运行时的那一页不带应用的信封字段。engine 建出来但从不连接，lifespan 不跑。"""

from __future__ import annotations

import base64
import uuid
from collections.abc import AsyncGenerator

import httpx
import pytest
from fastapi import FastAPI

from agent_runtime.http import create_app
from agent_runtime.run_deps import AgentRunDeps, conversation_of
from agent_runtime.settings import AgentRunsSection, CompactionSection, ResolvedApp, RuntimeSettings
from agent_runtime.transcript.wire import TranscriptPage

APP_KEY = "bff-app-key-0123456789-0123456789-ab"
SESSION = "0b8e9f4c-6a1d-4f2e-9c3b-5d7a1e2f3c4d"
OWNER = "6f1d8a4e-2b7c-4e0a-9d51-3c2f7e8b9a10"


@pytest.fixture
def app() -> FastAPI:
    settings = RuntimeSettings(
        database_url="postgresql+asyncpg://nobody:nothing@127.0.0.1:1/never",
        credential_encryption_keys=(base64.urlsafe_b64encode(b"x" * 32).decode(),),
        apps=(ResolvedApp(id="bff", key=APP_KEY, admin=False),),
        agent_runs=AgentRunsSection(),
        compaction=CompactionSection(),
        log_level="WARNING",
        log_format="console",
    )
    return create_app(settings, plugins={})


@pytest.fixture
async def client(app: FastAPI) -> AsyncGenerator[httpx.AsyncClient]:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://runtime.test/v1",
        headers={"Authorization": f"Bearer {APP_KEY}"},
    ) as c:
        yield c


def test_the_runtime_page_carries_no_app_envelope_fields() -> None:
    overlays = {"title", "owner_user_id", "deleted_at", "forked_from", "fork_turn"}

    assert overlays.isdisjoint(TranscriptPage.model_fields)


def test_usage_is_charged_to_the_conversation_of_the_run_deps() -> None:
    deps = AgentRunDeps(user_id=uuid.UUID(OWNER), conversation_id=SESSION, user_name="logan")

    assert conversation_of(deps) == SESSION
    assert conversation_of(object()) is None


async def test_app_routes_need_the_app_key(app: FastAPI) -> None:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://runtime.test/v1"
    ) as anonymous:
        response = await anonymous.get(f"/sessions/{SESSION}/status")

    assert response.status_code == 401
    assert set(response.json()) == {"detail"}


async def test_owner_scoped_routes_need_the_owner(client: httpx.AsyncClient) -> None:
    response = await client.get(f"/sessions/{SESSION}/files")

    assert response.status_code == 422
    assert response.json()["detail"].startswith("X-End-User: ")


async def test_a_session_id_must_be_a_uuid(client: httpx.AsyncClient) -> None:
    response = await client.get("/sessions/not-a-session/status")

    assert response.status_code == 422
    assert response.json()["detail"].startswith("session_id: ")


@pytest.mark.parametrize("page_size", [0, 101])
async def test_page_size_is_bounded(client: httpx.AsyncClient, page_size: int) -> None:
    response = await client.get(
        f"/sessions/{SESSION}/transcript",
        params={"session_agent": "director", "page_size": page_size},
    )

    assert response.status_code == 422
    assert response.json()["detail"].startswith("page_size: ")


async def test_the_page_needs_the_session_agent_and_a_well_formed_stream(
    client: httpx.AsyncClient,
) -> None:
    missing = await client.get(f"/sessions/{SESSION}/transcript")
    bad_stream = await client.get(
        f"/sessions/{SESSION}/transcript", params={"session_agent": "director", "agent": "a b"}
    )

    assert (missing.status_code, bad_stream.status_code) == (422, 422)
    assert missing.json()["detail"].startswith("session_agent: ")
    assert bad_stream.json()["detail"].startswith("agent: ")


async def test_a_prompt_needs_the_agent_and_who_it_is_for(client: httpx.AsyncClient) -> None:
    response = await client.post(
        f"/sessions/{SESSION}/prompts",
        json={"prompt_id": "prm_1", "content": [{"type": "text", "text": "你好"}]},
        headers={"X-End-User": OWNER},
    )

    assert response.status_code == 422
    assert response.json()["detail"].startswith("user_name: ")


async def test_a_write_takes_only_the_canonical_path(client: httpx.AsyncClient) -> None:
    response = await client.put(
        f"/sessions/{SESSION}/files/notes//brief.md",
        json={"content": "x"},
        headers={"X-End-User": OWNER},
    )

    assert response.status_code == 422
    assert response.json()["detail"] == (
        "路径 'notes//brief.md' 不是规范形式，按工作区文件列表里的写法给"
    )


async def test_a_fork_turn_counts_from_one(client: httpx.AsyncClient) -> None:
    response = await client.post(
        f"/sessions/{SESSION}:fork",
        json={"target_id": str(uuid.uuid4()), "source_user": OWNER, "turn": 0},
        headers={"X-End-User": OWNER},
    )

    assert response.status_code == 422
    assert response.json()["detail"].startswith("turn: ")
