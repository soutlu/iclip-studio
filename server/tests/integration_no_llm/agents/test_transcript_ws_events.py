"""实时流 epoch 与会话生命周期帧。

客户端先读基线、再带 ``transcript_since`` + ``transcript_epoch`` 订阅；全局帧带属主，在写入提交之后发出，
同一段对话的帧按提交先后到达。
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient

from tests.helpers.agents import AgentSeed
from tests.helpers.ws import (
    AGENT_ID,
    open_conversation,
    settled,
    sign_in,
    sign_in_as,
    subscribe,
    until,
)


@pytest.fixture
def agent_seeds() -> tuple[AgentSeed, ...]:
    return (AgentSeed(AGENT_ID),)


def _send(tc: TestClient, conversation_id: str, prompt_id: str, **kwargs: Any) -> None:
    sent = tc.post(
        f"/conversations/{conversation_id}/prompts",
        json={"prompt_id": prompt_id, "content": [{"type": "text", "text": "走"}]},
        **kwargs,
    )
    assert sent.status_code == 200, sent.text


def _next_transcript_frame(ws: Any, *, tries: int = 40) -> dict[str, Any]:
    """下一帧 transcript 帧，不管是 reset 还是 ops；跳过回执、心跳与全局帧。"""

    for _ in range(tries):
        frame: dict[str, Any] = ws.receive_json()
        if frame.get("type", "").startswith("transcript."):
            return frame
    raise AssertionError("没收到 transcript 帧")


def test_subscribing_from_the_baseline_resumes_without_a_reset(
    ws_agent_app: FastAPI, pg_url: str
) -> None:
    """照 Kimi 的顺序：基线带来水位与实时流，订阅带着它们续上，服务端只补发，不回 reset。"""

    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        conversation_id = open_conversation(tc)
        _send(tc, conversation_id, "prm_base_1")
        settled(tc, conversation_id)

        page = tc.get(f"/conversations/{conversation_id}/transcript").json()
        seq, stream_epoch = page["seq"], page["stream_epoch"]
        assert seq > 0

        with tc.websocket_connect("/ws") as ws:
            assert ws.receive_json()["type"] == "server_hello"
            subscribe(ws, conversation_id, since=seq, epoch=stream_epoch)
            _send(tc, conversation_id, "prm_base_2")

            first = _next_transcript_frame(ws)
            assert first["type"] == "transcript.ops"
            assert first["payload"]["seq"] == seq + 1
            assert first["stream_epoch"] == stream_epoch
            settled(tc, conversation_id)


def test_a_watermark_without_its_epoch_or_from_another_stream_gets_a_reset(
    ws_agent_app: FastAPI, pg_url: str
) -> None:
    """只给序号、或 epoch 对不上，服务端分不出那是不是这条流的水位，回 reset 让客户端整页重拉。"""

    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        conversation_id = open_conversation(tc)
        _send(tc, conversation_id, "prm_epoch")
        settled(tc, conversation_id)
        page = tc.get(f"/conversations/{conversation_id}/transcript").json()

        with tc.websocket_connect("/ws") as ws:
            assert ws.receive_json()["type"] == "server_hello"

            subscribe(ws, conversation_id, since=page["seq"], frame_id="s1")
            bare = _next_transcript_frame(ws)
            assert bare["type"] == "transcript.reset"
            assert bare["stream_epoch"] == page["stream_epoch"]
            assert bare["payload"]["seq"] == page["seq"]

            subscribe(ws, conversation_id, since=page["seq"], epoch="另一条流", frame_id="s2")
            foreign = _next_transcript_frame(ws)
            assert foreign["type"] == "transcript.reset"
            assert foreign["stream_epoch"] == page["stream_epoch"]


def test_lifecycle_frames_carry_the_owner_in_commit_order(
    ws_agent_app: FastAPI, pg_url: str
) -> None:
    """建、开跑、改名、换需求单、换合集、删各发一帧，提交之后发出，按写入的先后到达。"""

    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        owner_id = tc.get("/users/me").json()["user"]["id"]

        with tc.websocket_connect("/ws") as ws:
            assert ws.receive_json()["type"] == "server_hello"

            conversation_id = open_conversation(tc)
            created = until(ws, "event.session.created")
            assert (created["session_id"], created["owner_user_id"]) == (conversation_id, owner_id)
            assert created["payload"]["id"] == conversation_id
            assert created["payload"]["ownerUserId"] == owner_id
            assert set(created) == {"type", "session_id", "owner_user_id", "timestamp", "payload"}

            _send(tc, conversation_id, "prm_life")
            busy = until(ws, "event.session.work_changed")
            # 开跑记录运行也是一次行变化：带出新的 lastRunId 与抹掉的收尾标记。
            began = until(ws, "event.session.updated")
            until(ws, "event.session.work_changed")
            assert busy["owner_user_id"] == owner_id
            assert began["payload"]["lastRunId"] is not None
            assert began["payload"]["completedAt"] is None
            settled(tc, conversation_id)

            renamed = tc.patch(f"/conversations/{conversation_id}", json={"title": "改过的"})
            assert renamed.status_code == 200, renamed.text
            title = until(ws, "session.meta.updated")
            updated = until(ws, "event.session.updated")
            assert title["owner_user_id"] == owner_id
            assert (title["session_id"], title["payload"]) == (conversation_id, {"title": "改过的"})
            assert updated["payload"]["title"] == "改过的"

            unlinked = tc.put(f"/conversations/{conversation_id}/task", json={"taskId": None})
            assert unlinked.status_code == 200, unlinked.text
            detached = until(ws, "event.session.updated")
            assert detached["payload"]["taskId"] is None

            moved = tc.put(
                f"/conversations/{conversation_id}/collection", json={"collectionId": None}
            )
            assert moved.status_code == 200, moved.text
            regrouped = until(ws, "event.session.updated")
            assert regrouped["payload"]["collectionId"] is None

            assert tc.delete(f"/conversations/{conversation_id}").status_code == 204
            deleted = until(ws, "event.session.deleted")
            # 对话 id 只在外层，没有 payload。
            assert set(deleted) == {"type", "session_id", "owner_user_id", "timestamp"}
            assert deleted["session_id"] == conversation_id
            assert deleted["owner_user_id"] == owner_id


def test_an_idempotent_replay_of_create_announces_nothing(
    ws_agent_app: FastAPI, pg_url: str
) -> None:
    """带同一个 id 重发建对话不是新出现的对话，不发 created。"""

    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        first = tc.post("/conversations", json={"agentId": AGENT_ID})
        conversation_id = first.json()["conversation"]["id"]

        with tc.websocket_connect("/ws") as ws:
            assert ws.receive_json()["type"] == "server_hello"
            again = tc.post("/conversations", json={"agentId": AGENT_ID, "id": conversation_id})
            assert again.status_code == 200, again.text
            other = open_conversation(tc)
            assert until(ws, "event.session.created")["session_id"] == other


def test_a_fork_announces_its_copy_as_created(ws_agent_app: FastAPI, pg_url: str) -> None:
    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        source = open_conversation(tc)
        _send(tc, source, "prm_fork_src")
        settled(tc, source)

        with tc.websocket_connect("/ws") as ws:
            assert ws.receive_json()["type"] == "server_hello"
            forked = tc.post(f"/conversations/{source}:fork", json={"turn": 1})
            assert forked.status_code == 201, forked.text
            created = until(ws, "event.session.created")
            assert created["session_id"] == forked.json()["conversation"]["id"]
            assert created["payload"]["forkedFrom"] == source


def test_the_governor_receives_other_peoples_lifecycle_frames_with_their_owner(
    ws_agent_app: FastAPI, pg_url: str
) -> None:
    """治理者的连接收全平台的帧，靠帧上的属主分清哪些不是自己的对话。"""

    with TestClient(ws_agent_app) as tc:
        owner = sign_in_as(tc, pg_url, username="logan", roles=("editor",))
        governor = sign_in_as(tc, pg_url, username="gov", roles=("root",))
        owner_id = tc.get("/users/me", headers=owner).json()["user"]["id"]

        with tc.websocket_connect("/ws", headers=governor) as gov_ws:
            assert gov_ws.receive_json()["type"] == "server_hello"
            conversation_id = open_conversation(tc, headers=owner)
            created = until(gov_ws, "event.session.created")
            assert (created["session_id"], created["owner_user_id"]) == (conversation_id, owner_id)
            assert tc.delete(f"/conversations/{conversation_id}", headers=owner).status_code == 204
            assert until(gov_ws, "event.session.deleted")["owner_user_id"] == owner_id
