"""轮次开始回调不等起名：起标题的模型被卡住时回调照样答 204，放开后标题才落到对话上。"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator, Mapping

import httpx
import pytest
from agent_runtime.config.model_providers.schemas import DefaultModelIn
from fastapi import FastAPI
from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart
from pydantic_ai.models import Model
from pydantic_ai.models.function import AgentInfo, FunctionModel

from tests.helpers.agents import TEST_PROVIDER, AgentSeed
from tests.helpers.app import TEST_MODEL_NAME, new_conversation
from tests.helpers.auth import login_as_editor
from tests.helpers.ws import AGENT_ID

TOKEN = "runtime-internal-test-token-0123456789"
AUTHORIZED = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture
def base_env(base_env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RUNTIME_INTERNAL_TOKEN", TOKEN)


@pytest.fixture
def agent_seeds() -> tuple[AgentSeed, ...]:
    return (AgentSeed(AGENT_ID),)


@pytest.fixture
async def title_gate() -> AsyncGenerator[asyncio.Event]:
    """起标题的模型在它放开之前不答；用例结束时一定放开，后台任务不留着。"""

    gate = asyncio.Event()
    try:
        yield gate
    finally:
        gate.set()


@pytest.fixture
def models(title_gate: asyncio.Event) -> Mapping[str, Model]:
    async def titled(_messages: list[ModelMessage], _info: AgentInfo) -> ModelResponse:
        await title_gate.wait()
        return ModelResponse(parts=[TextPart("「连衣裙短视频」")])

    return {TEST_MODEL_NAME: FunctionModel(function=titled)}


async def test_turn_started_answers_before_the_title_is_generated(
    app: FastAPI, client: httpx.AsyncClient, pg_url: str, title_gate: asyncio.Event
) -> None:
    providers = app.state.agent_services.model_providers
    found = await providers.resolved(TEST_PROVIDER)
    assert found is not None
    await providers.set_default_model(
        "llm", DefaultModelIn(provider_id=found.provider.id, model_name=TEST_MODEL_NAME)
    )
    await login_as_editor(client, pg_url)
    conversation_id = await new_conversation(client, AGENT_ID)
    before = (await client.get(f"/conversations/{conversation_id}")).json()["conversation"]

    answered = await client.post(
        "/internal/runtime/hooks/turn-started",
        json={"session_id": conversation_id, "text": "给新款连衣裙做一条 15 秒的短视频"},
        headers=AUTHORIZED,
    )
    pending = (await client.get(f"/conversations/{conversation_id}")).json()["conversation"]
    title_gate.set()
    await app.state.turn_naming.wait()
    named = (await client.get(f"/conversations/{conversation_id}")).json()["conversation"]

    assert answered.status_code == 204
    assert pending["title"] == before["title"]
    assert named["title"] == "连衣裙短视频"
