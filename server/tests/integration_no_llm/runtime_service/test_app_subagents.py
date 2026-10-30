"""运行时服务读子代理那条流：主 agent 派活之后，按子代理的 id 读它那一页与补批，名册与主页同一份。"""

from __future__ import annotations

import uuid
from typing import Any

import httpx
import pytest
from pydantic_ai.models import Model

from tests.helpers.app import TEST_MODEL_NAME
from tests.helpers.runtime import delegates, says
from tests.helpers.runtime_service import add_model, connect_provider, publish_agent, settled

AGENT = "director"
WRITER = "shot-writer"
WRITER_MODEL = "writer-model"
TASK = "写第 3 组的三个镜头"


@pytest.fixture
def models() -> dict[str, Model]:
    return {TEST_MODEL_NAME: delegates((WRITER, TASK)), WRITER_MODEL: says("S3-1 特写")}


def _child_of(page: dict[str, Any]) -> str:
    agents = [one["agentId"] for one in page["agents"] if one["agentId"] != "main"]
    assert len(agents) == 1, page["agents"]
    return str(agents[0])


async def test_a_child_stream_is_read_by_its_agent_id(
    running: None, admin: httpx.AsyncClient, app_client: httpx.AsyncClient
) -> None:
    provider_id = await connect_provider(admin)
    await add_model(admin, provider_id, TEST_MODEL_NAME)
    await add_model(admin, provider_id, WRITER_MODEL)
    await publish_agent(admin, WRITER, model=WRITER_MODEL, listed=False)
    await publish_agent(admin, AGENT, subagents=(WRITER,))
    session = str(uuid.uuid4())
    assert (
        await app_client.post("/sessions", json={"id": session, "agent_id": AGENT})
    ).status_code == 204
    sent = await app_client.post(
        f"/sessions/{session}/prompts",
        json={
            "prompt_id": "prm_plan",
            "content": [{"type": "text", "text": "给这条视频做分镜"}],
            "user_name": "logan",
            "agent_id": AGENT,
        },
    )
    assert sent.status_code == 200, sent.text
    await settled(app_client, session)

    main = await app_client.get(f"/sessions/{session}/transcript", params={"session_agent": AGENT})
    child_id = _child_of(main.json())

    child = await app_client.get(
        f"/sessions/{session}/transcript", params={"session_agent": AGENT, "agent": child_id}
    )
    assert child.status_code == 200, child.text
    assert child.json()["agent_id"] == child_id
    assert [(turn["turnId"], turn["state"]) for turn in child.json()["items"]] == [
        ("t1", "completed")
    ]
    assert child.json()["items"][0]["content"] == [{"type": "text", "text": TASK}]
    assert [one["agentId"] for one in child.json()["agents"]] == ["main", child_id]

    ops = await app_client.get(
        f"/sessions/{session}/transcript/ops", params={"since_seq": 0, "agent": child_id}
    )
    assert ops.status_code == 200, ops.text
    assert ops.json()["agent_id"] == child_id
