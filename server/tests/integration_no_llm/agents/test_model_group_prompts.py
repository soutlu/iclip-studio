"""发消息与自动起标题按对话属主的配置组：看后端发给运行时的请求里带的 ``model_group``。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest
from agent_runtime.config.model_providers.schemas import CredentialCreateIn
from fastapi import FastAPI
from pydantic_ai.models.test import TestModel
from sqlalchemy.ext.asyncio import AsyncEngine

from tests.helpers.agents import AgentSeed, model_builder, seed_agents
from tests.helpers.app import (
    TEST_MODEL_NAME,
    make_client,
    make_runtime_config,
    new_conversation,
    settled,
)
from tests.helpers.auth import login_as_editor, set_direct_permissions_in_db
from tests.helpers.model_groups import MKT, MKT_DEPARTMENT, set_departments, with_model_groups
from tests.helpers.model_providers import GOOD_KEY, KeyCheckingProbe
from tests.helpers.runtime_backed import build_backed_app, config_services_of

AGENT_ID = "storyboard"

PROMPT = {"prompt_id": "prm_grouped", "content": [{"type": "text", "text": "做一条春季新款视频"}]}


@pytest.fixture
def runtime_requests() -> list[httpx.Request]:
    return []


@pytest.fixture
async def app(
    base_env: None, engine: AsyncEngine, tmp_path: Path, runtime_requests: list[httpx.Request]
) -> FastAPI:
    built = build_backed_app(
        with_model_groups(make_runtime_config(), {MKT: [MKT_DEPARTMENT]}),
        engine=engine,
        build_model=model_builder({TEST_MODEL_NAME: TestModel()}),
        credential_probe=KeyCheckingProbe({GOOD_KEY}),
        skill_cache_dir=tmp_path / "skills",
        runtime_requests=runtime_requests,
    )
    services = config_services_of(built)
    seeded = await seed_agents(services, engine, (AgentSeed(AGENT_ID),))
    # 组在要用的供应商下没有密钥时运行时不受理，所以给测试供应商配一把归 mkt 的。
    await services.model_providers.create_credential(
        seeded.provider_id,
        CredentialCreateIn(name="市场部", fields={"api_key": GOOD_KEY}, model_group=MKT),
        created_by=seeded.author,
    )
    return built


def sent_groups(requests: list[httpx.Request], path: str) -> list[Any]:
    """发到 ``path`` 的 POST 请求体里的 ``model_group``；没带即默认组，记为 ``None``。"""

    return [
        json.loads(request.content).get("model_group")
        for request in requests
        if request.method == "POST" and request.url.path == path
    ]


@pytest.mark.parametrize(
    ("departments", "expected"),
    [([MKT_DEPARTMENT], MKT), ([], None)],
    ids=["owner_in_mkt", "owner_in_default_group"],
)
async def test_a_prompt_and_the_title_it_triggers_carry_the_owners_group(
    app: FastAPI,
    engine: AsyncEngine,
    pg_url: str,
    runtime_requests: list[httpx.Request],
    departments: list[int],
    expected: str | None,
) -> None:
    async with make_client(app) as client:
        owner = await login_as_editor(client, pg_url)
        await set_departments(engine, owner, departments)
        conversation_id = await new_conversation(client, AGENT_ID)

        sent = await client.post(f"/conversations/{conversation_id}/prompts", json=PROMPT)
        assert sent.status_code == 200, sent.text
        await settled(client, conversation_id)
        await app.state.turn_naming.wait()

    assert sent_groups(runtime_requests, f"/v1/sessions/{conversation_id}/prompts") == [expected]
    assert sent_groups(runtime_requests, "/v1/titles") == [expected]


async def test_a_preview_prompt_carries_the_previewers_group(
    app: FastAPI, engine: AsyncEngine, pg_url: str, runtime_requests: list[httpx.Request]
) -> None:
    async with make_client(app) as client:
        owner = await login_as_editor(client, pg_url)
        await set_departments(engine, owner, [MKT_DEPARTMENT])
        await set_direct_permissions_in_db(pg_url, "logan@example.com", ["agent:manage"])
        opened = await client.post(f"/agents/{AGENT_ID}/previews")
        assert opened.status_code == 201, opened.text
        preview_id = opened.json()["id"]

        sent = await client.post(f"/conversations/{preview_id}/prompts", json=PROMPT)
        assert sent.status_code == 200, sent.text
        await settled(client, preview_id)

    assert sent_groups(runtime_requests, f"/v1/sessions/{preview_id}/prompts") == [MKT]
