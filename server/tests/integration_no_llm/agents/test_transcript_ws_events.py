"""实时流 epoch、会话事件水位与会话生命周期帧（ADR-0004）。

客户端先读基线、再带 ``transcript_since`` + ``transcript_epoch`` 订阅；全局帧带属主与这段对话的事件
序号，列表行带读行之前的水位，两边按序号比先后。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient

from iclip.config import ResolvedAgent
from tests.helpers.agents import declared_agent
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
def agent_declarations(tmp_path: Path) -> tuple[ResolvedAgent, ...]:
    return (declared_agent(tmp_path, AGENT_ID),)


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


def test_transcript_frames_carry_the_conversations_event_watermark_without_advancing_it(
    ws_agent_app: FastAPI, pg_url: str
) -> None:
    """Transcript 帧信封上的 ``epoch`` + ``seq`` 是这段对话当前的事件序号，照 Kimi 的易失帧不另发号。"""

    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        conversation_id = open_conversation(tc)
        row = tc.get(f"/conversations/{conversation_id}").json()["conversation"]

        with tc.websocket_connect("/ws") as ws:
            assert ws.receive_json()["type"] == "server_hello"
            subscribe(ws, conversation_id)
            reset = until(ws, "transcript.reset")
            assert reset["epoch"] == row["eventEpoch"]
            assert reset["seq"] == row["lastSeq"]

            _send(tc, conversation_id, "prm_env")
            busy = until(ws, "event.session.work_changed")
            ops = until(ws, "transcript.ops")
            assert ops["seq"] >= busy["seq"]
            settled(tc, conversation_id)

        after = tc.get(f"/conversations/{conversation_id}").json()["conversation"]
        assert after["lastSeq"] > busy["seq"], "跑完那一帧 idle 在读行之前发出，行的水位越过它"


def test_lifecycle_frames_carry_the_owner_and_order_against_row_watermarks(
    ws_agent_app: FastAPI, pg_url: str
) -> None:
    """建、改、标收尾、删各是一帧事件，提交后发新号；带整行的帧，行内 ``lastSeq`` 是写之前的水位。"""

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
            assert created["payload"]["lastSeq"] == 0
            assert created["seq"] == 1
            assert created["epoch"] == created["payload"]["eventEpoch"]

            _send(tc, conversation_id, "prm_life")
            busy = until(ws, "event.session.work_changed")
            idle = until(ws, "event.session.work_changed")
            assert busy["owner_user_id"] == owner_id
            assert created["seq"] < busy["seq"] < idle["seq"]
            settled(tc, conversation_id)

            renamed = tc.patch(f"/conversations/{conversation_id}", json={"title": "改过的"})
            assert renamed.status_code == 200, renamed.text
            title = until(ws, "session.meta.updated")
            updated = until(ws, "event.session.updated")
            assert title["owner_user_id"] == owner_id
            assert title["seq"] == idle["seq"] + 1
            assert updated["seq"] == title["seq"] + 1
            # 行写于取水位之后：行内水位停在写之前，帧自己发的号更大。
            assert updated["payload"]["lastSeq"] == idle["seq"]
            assert updated["payload"]["title"] == "改过的"
            assert renamed.json()["conversation"]["lastSeq"] == idle["seq"]

            unlinked = tc.put(f"/conversations/{conversation_id}/task", json={"taskId": None})
            assert unlinked.status_code == 200, unlinked.text
            detached = until(ws, "event.session.updated")
            assert detached["payload"]["taskId"] is None
            assert detached["seq"] == updated["seq"] + 1

            moved = tc.put(
                f"/conversations/{conversation_id}/collection", json={"collectionId": None}
            )
            assert moved.status_code == 200, moved.text
            regrouped = until(ws, "event.session.updated")
            assert regrouped["payload"]["collectionId"] is None
            assert regrouped["seq"] == detached["seq"] + 1

            assert tc.delete(f"/conversations/{conversation_id}").status_code == 204
            deleted = until(ws, "event.session.deleted")
            assert deleted["session_id"] == conversation_id
            assert deleted["payload"] == {"session_id": conversation_id}
            assert deleted["owner_user_id"] == owner_id
            assert deleted["seq"] == regrouped["seq"] + 1


def test_a_row_read_before_a_write_cannot_overwrite_the_updated_frame(
    ws_agent_app: FastAPI, pg_url: str
) -> None:
    """写入之前读库的 HTTP 行晚于 ``updated`` 帧到达时，序号关系保证它盖不掉帧带来的事实字段。

    客户端按帧的信封序号记行内事实字段的水位，HTTP 行只盖过序号不大于它 ``lastSeq`` 的字段。旧行的
    ``lastSeq`` 严格小于帧序号，所以收尾标记留在帧上的值；两者若相等（帧不另发号），旧行会盖回去。"""

    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        conversation_id = open_conversation(tc)

        with tc.websocket_connect("/ws") as ws:
            assert ws.receive_json()["type"] == "server_hello"

            stale = tc.get(f"/conversations/{conversation_id}").json()["conversation"]
            assert stale["completedAt"] is None

            done = tc.put(f"/conversations/{conversation_id}/completion", json={"completed": True})
            assert done.status_code == 200, done.text
            marked = until(ws, "event.session.updated")

            assert marked["payload"]["completedAt"] is not None
            assert marked["payload"]["lastSeq"] == stale["lastSeq"]
            assert stale["lastSeq"] < marked["seq"]
            assert marked["epoch"] == stale["eventEpoch"]


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
