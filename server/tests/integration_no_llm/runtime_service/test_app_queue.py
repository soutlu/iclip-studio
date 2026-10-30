"""运行时服务的会话接口在一轮还卡着的时候：排着的消息能撤，整段能停，活动与占位读得出来，分叉被挡住。

模型在一扇门上等着，门由用例开，运行中的状态是确定的。"""

from __future__ import annotations

import asyncio
import uuid

import httpx
import pytest
from pydantic_ai.models import Model

from tests.helpers.app import TEST_MODEL_NAME
from tests.helpers.runtime import waits
from tests.helpers.runtime_service import add_model, connect_provider, publish_agent, settled

AGENT = "director"


@pytest.fixture
def entered() -> asyncio.Event:
    return asyncio.Event()


@pytest.fixture
def gate() -> asyncio.Event:
    return asyncio.Event()


@pytest.fixture
def models(entered: asyncio.Event, gate: asyncio.Event) -> dict[str, Model]:
    return {TEST_MODEL_NAME: waits(entered, gate)}


@pytest.fixture
async def session(admin: httpx.AsyncClient, app_client: httpx.AsyncClient) -> str:
    provider_id = await connect_provider(admin)
    await add_model(admin, provider_id, TEST_MODEL_NAME)
    await publish_agent(admin, AGENT)
    session_id = str(uuid.uuid4())
    opened = await app_client.post("/sessions", json={"id": session_id, "agent_id": AGENT})
    assert opened.status_code == 204, opened.text
    return session_id


async def send(client: httpx.AsyncClient, session_id: str, prompt_id: str) -> str:
    sent = await client.post(
        f"/sessions/{session_id}/prompts",
        json={
            "prompt_id": prompt_id,
            "content": [{"type": "text", "text": prompt_id}],
            "user_name": "logan",
            "agent_id": AGENT,
        },
    )
    assert sent.status_code == 200, sent.text
    return str(sent.json()["status"])


async def test_a_queued_prompt_is_aborted_while_the_first_one_runs(
    running: None,
    app_client: httpx.AsyncClient,
    session: str,
    owner: uuid.UUID,
    entered: asyncio.Event,
    gate: asyncio.Event,
) -> None:
    assert await send(app_client, session, "prm_first") == "running"
    await asyncio.wait_for(entered.wait(), timeout=10)
    assert await send(app_client, session, "prm_second") == "queued"

    aborted = await app_client.post(f"/sessions/{session}/prompts/prm_second:abort")
    assert aborted.status_code == 204, aborted.text
    queue = (await app_client.get(f"/sessions/{session}/prompts")).json()
    assert queue["active"]["promptId"] == "prm_first"
    assert queue["queued"] == []
    assert (await app_client.get(f"/sessions/{session}/status")).json() == {"status": "running"}

    unknown = str(uuid.uuid4())
    activities = await app_client.post("/sessions:activities", json={"ids": [session, unknown]})
    assert activities.status_code == 200, activities.text
    # 不存在的会话不在答复里。
    assert activities.json() == {
        "items": {
            session: {"busy": True, "pending_interaction": "none", "last_turn_reason": None},
        }
    }
    everyone = await app_client.get("/sessions:busy")
    mine = await app_client.get("/sessions:busy", params={"end_user": str(owner)})
    someone_else = await app_client.get("/sessions:busy", params={"end_user": str(uuid.uuid4())})
    assert everyone.json() == mine.json() == {"ids": [session]}
    assert someone_else.json() == {"ids": []}

    fork = await app_client.post(
        f"/sessions/{session}:fork",
        json={"target_id": str(uuid.uuid4()), "source_user": str(owner), "turn": 1},
    )
    assert fork.status_code == 409
    assert fork.json()["detail"] == "这段对话还有没跑完的消息，等它收完尾再分叉"

    gate.set()
    await settled(app_client, session)
    assert (await app_client.get(f"/sessions/{session}/status")).json() == {"status": "completed"}
    finished = await app_client.post("/sessions:activities", json={"ids": [session]})
    assert finished.json()["items"][session] == {
        "busy": False,
        "pending_interaction": "none",
        "last_turn_reason": "completed",
    }
    assert (await app_client.get("/sessions:busy")).json() == {"ids": []}


async def test_aborting_the_session_stops_the_running_turn(
    running: None, app_client: httpx.AsyncClient, session: str, entered: asyncio.Event
) -> None:
    await send(app_client, session, "prm_first")
    await asyncio.wait_for(entered.wait(), timeout=10)

    aborted = await app_client.post(f"/sessions/{session}:abort")
    assert aborted.status_code == 204, aborted.text
    await settled(app_client, session)

    assert (await app_client.get(f"/sessions/{session}/status")).json() == {"status": "aborted"}
    # 什么都没在跑时再停一次照样 204。
    assert (await app_client.post(f"/sessions/{session}:abort")).status_code == 204
