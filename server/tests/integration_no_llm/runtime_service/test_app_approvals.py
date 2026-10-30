"""运行时服务的审批：挂着要审批工具的 agent 停在等审批，经会话接口点同意后续跑完；改主意 409，不在等回应的
卡 404。工具来自交给服务的测试插件 ``approving``。"""

from __future__ import annotations

import asyncio
import uuid

import httpx
import pytest
from agent_runtime.plugins.base import PluginRegistry
from pydantic_ai.models import Model

from tests.helpers.app import TEST_MODEL_NAME
from tests.helpers.runtime import calls_then_says
from tests.helpers.runtime_service import (
    ApprovingPlugin,
    add_model,
    connect_provider,
    publish_agent,
    settled,
)

AGENT = "director"


@pytest.fixture
def plugin_registry() -> PluginRegistry:
    return {"approving": ApprovingPlugin}


@pytest.fixture
def models() -> dict[str, Model]:
    # 一口气调两次：两张卡凑齐决定才续跑，第一张点过之后改主意还在等回应的那一批里。
    return {TEST_MODEL_NAME: calls_then_says("write_file", "改完了", calls=2)}


async def awaiting(client: httpx.AsyncClient, session_id: str, *, tries: int = 250) -> None:
    for _ in range(tries):
        if (await client.get(f"/sessions/{session_id}/status")).json()["status"] == "awaiting":
            return
        await asyncio.sleep(0.02)
    raise AssertionError("这段会话没停在等审批")


async def test_an_approval_resumes_the_run(
    running: None, admin: httpx.AsyncClient, app_client: httpx.AsyncClient
) -> None:
    provider_id = await connect_provider(admin)
    await add_model(admin, provider_id, TEST_MODEL_NAME)
    await publish_agent(admin, AGENT, plugins=("approving",))
    session = str(uuid.uuid4())
    assert (
        await app_client.post("/sessions", json={"id": session, "agent_id": AGENT})
    ).status_code == 204

    sent = await app_client.post(
        f"/sessions/{session}/prompts",
        json={
            "prompt_id": "prm_write",
            "content": [{"type": "text", "text": "改一下文件"}],
            "user_name": "logan",
            "agent_id": AGENT,
        },
    )
    assert sent.status_code == 200, sent.text
    await awaiting(app_client, session)

    activity = await app_client.post("/sessions:activities", json={"ids": [session]})
    assert activity.json()["items"][session]["pending_interaction"] == "approval"
    page = await app_client.get(f"/sessions/{session}/transcript", params={"session_agent": AGENT})
    first, second = page.json()["pending_interactions"]

    unknown = await app_client.post(
        f"/sessions/{session}/interactions/nope", json={"approved": True}
    )
    assert unknown.status_code == 404
    approved = await app_client.post(
        f"/sessions/{session}/interactions/{first}", json={"approved": True}
    )
    assert approved.status_code == 204, approved.text
    again = await app_client.post(
        f"/sessions/{session}/interactions/{first}", json={"approved": True}
    )
    changed_mind = await app_client.post(
        f"/sessions/{session}/interactions/{first}", json={"approved": False}
    )
    assert (again.status_code, changed_mind.status_code) == (204, 409)

    last = await app_client.post(
        f"/sessions/{session}/interactions/{second}", json={"approved": True}
    )
    assert last.status_code == 204, last.text
    await settled(app_client, session)
    assert (await app_client.get(f"/sessions/{session}/status")).json() == {"status": "completed"}
