"""后端给运行时的内部接口：没配令牌就不挂、令牌不对 401，以及开跑检查、运行开始与轮次开始三个回调。

回调请求体是运行时 ``agent_runtime.hooks`` 的模型，这里按它们的 JSON 形状直接发。"""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from datetime import datetime
from typing import Any

import httpx
import pytest
from agent_runtime.config.model_providers.schemas import DefaultModelIn
from fastapi import FastAPI
from pydantic_ai.models import Model
from pydantic_ai.models.test import TestModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine
from starlette.testclient import TestClient

from iclip.app.bootstrap import AgentServices
from tests.helpers.agents import TEST_PROVIDER, AgentSeed
from tests.helpers.app import TEST_MODEL_NAME, new_conversation
from tests.helpers.auth import login_as_editor
from tests.helpers.references import plant_user
from tests.helpers.ws import AGENT_ID, open_conversation, sign_in, until

TOKEN = "runtime-internal-test-token-0123456789"
"""测试用的内部令牌，不少于 32 个字符。"""

AUTHORIZED = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture
def runtime_token() -> str | None:
    return TOKEN


@pytest.fixture
def base_env(base_env: None, monkeypatch: pytest.MonkeyPatch, runtime_token: str | None) -> None:
    if runtime_token is None:
        monkeypatch.delenv("RUNTIME_INTERNAL_TOKEN", raising=False)
    else:
        monkeypatch.setenv("RUNTIME_INTERNAL_TOKEN", runtime_token)


@pytest.fixture
def agent_seeds() -> tuple[AgentSeed, ...]:
    return (AgentSeed(AGENT_ID),)


@pytest.fixture
def models() -> Mapping[str, Model]:
    return {TEST_MODEL_NAME: TestModel(custom_output_text="「连衣裙短视频」")}


def gate_body(owner: uuid.UUID) -> dict[str, Any]:
    return {
        "session_id": str(uuid.uuid4()),
        "owner_user_id": str(owner),
        "user_name": "logan",
        "prompt_id": "prm_1",
        "run_id": None,
    }


IDLE = {"busy": False, "pending_interaction": "none"}


@pytest.mark.parametrize("runtime_token", [None])
async def test_without_the_token_no_internal_route_is_mounted(client: httpx.AsyncClient) -> None:
    gate = await client.post(
        "/internal/runtime/hooks/gate", json=gate_body(uuid.uuid4()), headers=AUTHORIZED
    )
    models = await client.get("/internal/runtime/plugins/image-models", headers=AUTHORIZED)

    assert (gate.status_code, models.status_code) == (404, 404)


@pytest.mark.parametrize(
    "headers",
    [{}, {"Authorization": f"Bearer {TOKEN[:-1]}x"}, {"Authorization": f"Basic {TOKEN}"}],
    ids=["missing", "wrong", "not-bearer"],
)
async def test_a_missing_or_wrong_bearer_is_401_in_the_error_envelope(
    client: httpx.AsyncClient, engine: AsyncEngine, headers: dict[str, str]
) -> None:
    owner = await plant_user(engine, "logan")

    gate = await client.post("/internal/runtime/hooks/gate", json=gate_body(owner), headers=headers)
    models = await client.get("/internal/runtime/plugins/image-models", headers=headers)

    assert (gate.status_code, models.status_code) == (401, 401)
    assert gate.json() == {"detail": "运行时内部接口的令牌不对"}


async def test_the_gate_lets_an_active_owner_through(
    client: httpx.AsyncClient, engine: AsyncEngine
) -> None:
    owner = await plant_user(engine, "logan")

    gate = await client.post(
        "/internal/runtime/hooks/gate", json=gate_body(owner), headers=AUTHORIZED
    )

    assert gate.status_code == 204, gate.text
    assert gate.content == b""


async def test_the_gate_refuses_a_deactivated_owner_with_403(
    client: httpx.AsyncClient, engine: AsyncEngine
) -> None:
    owner = await plant_user(engine, "logan")
    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE iclip.users SET is_active = false WHERE id = :id"), {"id": owner}
        )

    gate = await client.post(
        "/internal/runtime/hooks/gate", json=gate_body(owner), headers=AUTHORIZED
    )

    assert gate.status_code == 403
    assert gate.json() == {"detail": "账号已停用"}


async def test_the_gate_refuses_an_unknown_owner_with_404(client: httpx.AsyncClient) -> None:
    gate = await client.post(
        "/internal/runtime/hooks/gate", json=gate_body(uuid.uuid4()), headers=AUTHORIZED
    )

    assert gate.status_code == 404
    assert gate.json() == {"detail": "用户不存在"}


def test_run_started_records_the_run_and_broadcasts_the_reported_activity(
    ws_agent_app: FastAPI, pg_url: str
) -> None:
    """回调报的活动是「在跑、等审批」，而这段对话其实没有消息在跑：行里是回调那份，就说明没再去读。"""

    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        conversation_id = open_conversation(tc)
        marked = tc.put(f"/conversations/{conversation_id}/completion", json={"completed": True})
        assert marked.status_code == 200, marked.text
        before = marked.json()["conversation"]

        with tc.websocket_connect("/ws") as ws:
            assert ws.receive_json()["type"] == "server_hello"
            started = tc.post(
                "/internal/runtime/hooks/run-started",
                json={
                    "session_id": conversation_id,
                    "run_id": "run-from-runtime",
                    "activity": {"busy": True, "pending_interaction": "approval"},
                },
                headers=AUTHORIZED,
            )
            assert started.status_code == 204, started.text
            updated = until(ws, "event.session.updated")

        row = tc.get(f"/conversations/{conversation_id}").json()["conversation"]

    assert updated["session_id"] == conversation_id
    assert updated["payload"]["lastRunId"] == "run-from-runtime"
    assert updated["payload"]["completedAt"] is None
    activity = updated["payload"]["activity"]
    assert (activity["busy"], activity["pendingInteraction"], activity["videoGeneration"]) == (
        True,
        "approval",
        "none",
    )
    assert (row["lastRunId"], row["completedAt"]) == ("run-from-runtime", None)
    assert datetime.fromisoformat(row["updatedAt"]) > datetime.fromisoformat(before["updatedAt"])


async def test_run_started_on_a_deleted_conversation_is_404(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    await login_as_editor(client, pg_url)
    conversation_id = await new_conversation(client, AGENT_ID)
    assert (await client.delete(f"/conversations/{conversation_id}")).status_code == 204

    started = await client.post(
        "/internal/runtime/hooks/run-started",
        json={"session_id": conversation_id, "run_id": "run-late", "activity": IDLE},
        headers=AUTHORIZED,
    )

    assert started.status_code == 404


async def set_default_llm(services: AgentServices) -> None:
    providers = services.model_providers
    found = await providers.resolved(TEST_PROVIDER)
    assert found is not None
    await providers.set_default_model(
        "llm", DefaultModelIn(provider_id=found.provider.id, model_name=TEST_MODEL_NAME)
    )


async def test_turn_started_names_the_conversation_once(
    app: FastAPI, client: httpx.AsyncClient, pg_url: str
) -> None:
    await set_default_llm(app.state.agent_services)
    await login_as_editor(client, pg_url)
    conversation_id = await new_conversation(client, AGENT_ID)
    body = {"session_id": conversation_id, "text": "给新款连衣裙做一条 15 秒的短视频"}

    first = await client.post("/internal/runtime/hooks/turn-started", json=body, headers=AUTHORIZED)
    named = (await client.get(f"/conversations/{conversation_id}")).json()["conversation"]
    renamed = await client.patch(f"/conversations/{conversation_id}", json={"title": "我改的"})
    assert renamed.status_code == 200, renamed.text
    second = await client.post(
        "/internal/runtime/hooks/turn-started", json=body, headers=AUTHORIZED
    )
    kept = (await client.get(f"/conversations/{conversation_id}")).json()["conversation"]

    assert (first.status_code, second.status_code) == (204, 204)
    assert named["title"] == "连衣裙短视频"
    assert kept["title"] == "我改的"


async def test_turn_started_on_a_deleted_conversation_is_still_204(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    await login_as_editor(client, pg_url)
    conversation_id = await new_conversation(client, AGENT_ID)
    assert (await client.delete(f"/conversations/{conversation_id}")).status_code == 204

    turned = await client.post(
        "/internal/runtime/hooks/turn-started",
        json={"session_id": conversation_id, "text": "做一条视频"},
        headers=AUTHORIZED,
    )

    assert turned.status_code == 204, turned.text
