from __future__ import annotations

import uuid
from typing import Any

import httpx
import pytest
from pydantic_ai.models import Model

from tests.helpers.runtime import says
from tests.helpers.runtime_service import (
    TEST_MODEL_NAME,
    add_model,
    connect_provider,
    publish_agent,
    settled,
)

AGENT = "director"
IMAGE = "https://bkt.oss-ap-southeast-1.aliyuncs.com/style.jpg"
VIDEO = "https://cdn.test/ref.mp4"


@pytest.fixture
def models() -> dict[str, Model]:
    return {TEST_MODEL_NAME: says("答：第一问", "答：重来一次")}


@pytest.fixture
async def session(admin: httpx.AsyncClient, app_client: httpx.AsyncClient) -> str:
    provider_id = await connect_provider(admin)
    await add_model(admin, provider_id, TEST_MODEL_NAME)
    await publish_agent(admin, AGENT)
    session_id = str(uuid.uuid4())
    opened = await app_client.post("/sessions", json={"id": session_id, "agent_id": AGENT})
    assert opened.status_code == 204, opened.text
    return session_id


def prompt(prompt_id: str, *content: dict[str, Any]) -> dict[str, Any]:
    return {
        "prompt_id": prompt_id,
        "content": [{"type": "text", "text": "第一问"}, *content],
        "user_name": "logan",
        "agent_id": AGENT,
    }


async def test_opening_a_session_checks_the_agent(
    admin: httpx.AsyncClient, app_client: httpx.AsyncClient
) -> None:
    unknown = await app_client.post("/sessions", json={"id": str(uuid.uuid4()), "agent_id": "nope"})

    assert unknown.status_code == 422
    assert set(unknown.json()) == {"detail"}


async def test_a_prompt_runs_to_completion_and_reads_back(
    running: None, app_client: httpx.AsyncClient, session: str
) -> None:
    sent = await app_client.post(
        f"/sessions/{session}/prompts",
        json=prompt(
            "prm_first",
            {"type": "image", "source": {"kind": "url", "url": IMAGE}},
            {"type": "video", "source": {"kind": "url", "url": VIDEO}},
        ),
    )
    assert sent.status_code == 200, sent.text
    assert sent.json()["promptId"] == "prm_first"
    await settled(app_client, session)

    status = await app_client.get(f"/sessions/{session}/status")
    assert status.json() == {"status": "completed"}

    page = await app_client.get(f"/sessions/{session}/transcript", params={"session_agent": AGENT})
    assert page.status_code == 200, page.text
    body = page.json()
    assert body["agent_id"] == "main"
    assert [(turn["turnId"], turn["state"]) for turn in body["items"]] == [("t1", "completed")]
    assert body["items"][0]["triggerPromptId"] == "prm_first"
    assert body["meta"]["activity"] == "idle"
    assert {"title", "owner_user_id", "deleted_at", "forked_from", "fork_turn"}.isdisjoint(body)

    ops = await app_client.get(f"/sessions/{session}/transcript/ops", params={"since_seq": 0})
    assert ops.status_code == 200, ops.text
    assert ops.json()["agent_id"] == "main"
    assert ops.json()["complete"] is True
    assert ops.json()["latest_seq"] == body["seq"]
    assert ops.json()["stream_epoch"] == body["stream_epoch"]
    assert ops.json()["batches"], "跑过一轮，补批里有东西"


async def test_a_prompt_for_an_agent_the_session_was_not_opened_with_is_refused(
    running: None, admin: httpx.AsyncClient, app_client: httpx.AsyncClient, session: str
) -> None:
    await publish_agent(admin, "storyboard")

    refused = await app_client.post(
        f"/sessions/{session}/prompts", json={**prompt("prm_other"), "agent_id": "storyboard"}
    )

    assert refused.status_code == 409
    assert refused.json()["code"] == "agent_unavailable"
    assert (await app_client.get(f"/sessions/{session}/prompts")).json() == {
        "active": None,
        "queued": [],
    }


async def test_the_last_turn_regenerates(
    running: None, app_client: httpx.AsyncClient, session: str
) -> None:
    sent = await app_client.post(f"/sessions/{session}/prompts", json=prompt("prm_first"))
    assert sent.status_code == 200, sent.text
    await settled(app_client, session)

    bad_turn = await app_client.post(f"/sessions/{session}/turns/1:regenerate")
    not_last = await app_client.post(f"/sessions/{session}/turns/t2:regenerate")
    assert (bad_turn.status_code, not_last.status_code) == (422, 409)
    assert bad_turn.json()["detail"] == "不是合法的轮 id：1"
    assert not_last.json()["detail"] == "只能重新生成最后一轮"

    regenerated = await app_client.post(
        f"/sessions/{session}/turns/t1:regenerate", json={"prompt_id": "prm_again"}
    )
    assert regenerated.status_code == 200, regenerated.text
    assert regenerated.json()["promptId"] == "prm_again"
    await settled(app_client, session)

    page = await app_client.get(f"/sessions/{session}/transcript", params={"session_agent": AGENT})
    items = page.json()["items"]
    assert [(turn["turnId"], turn["triggerPromptId"]) for turn in items] == [("t1", "prm_again")]


async def test_a_child_stream_that_is_not_in_the_session_is_404(
    app_client: httpx.AsyncClient, session: str
) -> None:
    page = await app_client.get(
        f"/sessions/{session}/transcript",
        params={"session_agent": AGENT, "agent": str(uuid.uuid4())},
    )
    ops = await app_client.get(
        f"/sessions/{session}/transcript/ops",
        params={"since_seq": 0, "agent": str(uuid.uuid4())},
    )

    assert (page.status_code, ops.status_code) == (404, 404)
    assert page.json()["detail"] == "这段对话里没有这个 agent"
