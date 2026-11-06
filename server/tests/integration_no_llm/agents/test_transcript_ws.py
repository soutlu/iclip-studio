from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any

import pytest
from agent_runtime.harness.transcript.store import TranscriptStore
from fastapi import FastAPI
from sqlalchemy import text
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from tests.helpers.agents import AgentSeed
from tests.helpers.pg import connected
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


def test_closing_the_connection_releases_every_pin_and_listener(
    ws_agent_app: FastAPI, pg_url: str
) -> None:
    store: TranscriptStore = ws_agent_app.state.transcript_store
    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        first = open_conversation(tc)
        second = open_conversation(tc)
        assert not store.holds(first)
        assert not store.holds(second)

        with tc.websocket_connect("/ws") as ws:
            assert ws.receive_json()["type"] == "server_hello"
            subscribe(ws, first, frame_id="s1")
            subscribe(ws, second, frame_id="s2", grade="turn")
            until(ws, "transcript.reset")
            until(ws, "transcript.reset")
            assert store.holds(first)
            assert store.holds(second)

        assert not store.holds(first)
        assert not store.holds(second)


def test_subscribing_with_a_dashless_conversation_id_receives_frames(
    ws_agent_app: FastAPI, pg_url: str
) -> None:
    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        conversation_id = open_conversation(tc)
        dashless = uuid.UUID(conversation_id).hex

        with tc.websocket_connect("/ws") as ws:
            assert ws.receive_json()["type"] == "server_hello"
            subscribe(ws, dashless)

            assert until(ws, "transcript.reset")["session_id"] == conversation_id
            assert until(ws, "ack")["payload"]["accepted"] == [conversation_id]

            sent = tc.post(
                f"/conversations/{dashless}/prompts",
                json={"prompt_id": "prm_dashless", "content": [{"type": "text", "text": "走"}]},
            )
            assert sent.status_code == 200, sent.text
            assert until(ws, "transcript.ops")["session_id"] == conversation_id

            settled(tc, conversation_id)


def test_cross_origin_upgrade_is_refused(
    ws_agent_app: FastAPI, pg_url: str, caplog: pytest.LogCaptureFixture
) -> None:
    with (
        caplog.at_level(logging.INFO, logger="iclip.domains.agents.transcript_api"),
        TestClient(ws_agent_app) as tc,
    ):
        sign_in(tc, pg_url)

        with (
            pytest.raises(WebSocketDisconnect) as refused,
            tc.websocket_connect("/ws", headers={"origin": "https://evil.example"}),
        ):
            pass

    assert refused.value.code == 1008
    assert any(
        record.name == "iclip.domains.agents.transcript_api"
        and isinstance(record.msg, dict)
        and record.msg.get("origin") == "https://evil.example"
        for record in caplog.records
    )


def test_anonymous_upgrade_is_refused(ws_agent_app: FastAPI) -> None:
    with (
        TestClient(ws_agent_app) as tc,
        pytest.raises(WebSocketDisconnect) as refused,
        tc.websocket_connect("/ws"),
    ):
        pass

    assert refused.value.code == 1008


def test_a_signed_in_user_without_agent_run_is_refused(
    ws_agent_app: FastAPI, pg_url: str, caplog: pytest.LogCaptureFixture
) -> None:
    with (
        caplog.at_level(logging.INFO, logger="iclip.domains.agents.transcript_api"),
        TestClient(ws_agent_app) as tc,
    ):
        viewer = sign_in_as(tc, pg_url, username="vic", roles=("viewer",))

        with (
            pytest.raises(WebSocketDisconnect) as refused,
            tc.websocket_connect("/ws", headers=viewer),
        ):
            pass

    assert refused.value.code == 1008
    assert any(
        record.name == "iclip.domains.agents.transcript_api"
        and isinstance(record.msg, dict)
        and record.msg.get("user_id")
        for record in caplog.records
    )


def test_api_key_upgrades_with_bearer_alone(ws_agent_app: FastAPI, pg_url: str) -> None:
    with TestClient(ws_agent_app) as tc:
        root = sign_in_as(tc, pg_url, username="logan", roles=("root",))
        issued = tc.post(
            "/api-keys", json={"name": "ws", "permissions": ["agent:run"]}, headers=root
        )
        assert issued.status_code == 201, issued.text
        token = issued.json()["apiKey"]["token"]

        with tc.websocket_connect("/ws", headers={"Authorization": f"Bearer {token}"}) as ws:
            assert ws.receive_json()["type"] == "server_hello"


def test_same_origin_upgrade_is_accepted(ws_agent_app: FastAPI, pg_url: str) -> None:
    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        with tc.websocket_connect("/ws", headers={"origin": "http://testserver"}) as ws:
            assert ws.receive_json()["type"] == "server_hello"


@pytest.mark.parametrize("cors_allow_origins", [("https://allowed.example",)], ids=["allowlisted"])
def test_allowlisted_cross_origin_upgrade_is_accepted(ws_agent_app: FastAPI, pg_url: str) -> None:
    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        with tc.websocket_connect("/ws", headers={"origin": "https://allowed.example"}) as ws:
            assert ws.receive_json()["type"] == "server_hello"


async def _seed_file(pg_url: str, namespace: str, path: str, content: str) -> None:
    async with connected(pg_url) as conn:
        await conn.execute(
            text(
                "INSERT INTO agent_runtime.workspace_files "
                "(namespace, path, content, version, created_at, updated_at) "
                "VALUES (:ns, :path, :content, 1, now(), now())"
            ),
            {"ns": namespace, "path": path, "content": content},
        )


def _subscribed_off(ws: Any, conversation_id: str, frame_id: str = "s1") -> dict[str, Any]:
    subscribe(ws, conversation_id, grade="off", frame_id=frame_id)
    ack = until(ws, "ack")
    assert ack["id"] == frame_id
    return ack


def _put(tc: TestClient, conversation_id: str, path: str, body: str) -> None:
    written = tc.put(
        f"/conversations/{conversation_id}/workspace/file",
        json={"path": path, "content": body, "expectedVersion": 1},
    )
    assert written.status_code == 200, written.text


def test_a_subscribed_connection_gets_every_file_change_of_the_conversation_as_is(
    ws_agent_app: FastAPI, pg_url: str
) -> None:
    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        conversation_id = open_conversation(tc)
        owner = tc.get("/users/me").json()["user"]["id"]
        namespace = f"{owner}/{conversation_id}"
        asyncio.run(_seed_file(pg_url, namespace, "storyboard.md", "初稿"))
        asyncio.run(_seed_file(pg_url, namespace, "frames/grids/a.json", "{}"))

        with tc.websocket_connect("/ws") as ws:
            assert ws.receive_json()["type"] == "server_hello"
            assert _subscribed_off(ws, conversation_id)["payload"]["accepted"] == [conversation_id]
            _put(tc, conversation_id, "frames/grids/a.json", '{"v": 2}')
            _put(tc, conversation_id, "storyboard.md", "二稿")
            first = until(ws, "event.fs.changed")
            second = until(ws, "event.fs.changed")

    assert set(first) == {"type", "session_id", "timestamp", "payload"}
    assert first["session_id"] == conversation_id
    assert first["payload"] == {"changes": [{"path": "frames/grids/a.json", "change": "modified"}]}
    assert second["payload"] == {"changes": [{"path": "storyboard.md", "change": "modified"}]}


def test_activity_frames_reach_a_connection_that_subscribed_nothing(
    ws_agent_app: FastAPI, pg_url: str
) -> None:
    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        conversation_id = open_conversation(tc)

        with tc.websocket_connect("/ws") as ws:
            assert ws.receive_json()["type"] == "server_hello"

            sent = tc.post(
                f"/conversations/{conversation_id}/prompts",
                json={"prompt_id": "prm_act", "content": [{"type": "text", "text": "走"}]},
            )
            assert sent.status_code == 200, sent.text

            busy = until(ws, "event.session.work_changed")
            assert busy["session_id"] == conversation_id
            assert busy["payload"] == {"busy": True, "pending_interaction": "none"}

            idle = until(ws, "event.session.work_changed")
            assert idle["session_id"] == conversation_id
            assert idle["payload"] == {
                "busy": False,
                "pending_interaction": "none",
                "last_turn_reason": "completed",
            }

            listed = tc.get("/conversations").json()
            row = next(
                item for item in listed["ungrouped"]["items"] if item["id"] == conversation_id
            )
            assert row["activity"] == {
                "busy": False,
                "pendingInteraction": "none",
                "lastTurnReason": "completed",
            }


def test_governor_can_subscribe_to_a_deleted_conversation_but_its_owner_cannot(
    ws_agent_app: FastAPI, pg_url: str
) -> None:
    with TestClient(ws_agent_app) as tc:
        owner = sign_in_as(tc, pg_url, username="logan", roles=("editor",))
        governor = sign_in_as(tc, pg_url, username="gov", roles=("root",))
        conversation_id = open_conversation(tc, headers=owner)
        assert tc.delete(f"/conversations/{conversation_id}", headers=owner).status_code == 204

        with (
            tc.websocket_connect("/ws", headers=governor) as gov_ws,
            tc.websocket_connect("/ws", headers=owner) as owner_ws,
        ):
            assert gov_ws.receive_json()["type"] == "server_hello"
            assert owner_ws.receive_json()["type"] == "server_hello"

            subscribe(gov_ws, conversation_id, grade="turn")
            assert until(gov_ws, "transcript.reset")["session_id"] == conversation_id

            subscribe(owner_ws, conversation_id)
            assert until(owner_ws, "ack")["payload"]["not_found"] == [conversation_id]


def test_governor_receives_other_peoples_frames_and_a_stranger_receives_none(
    ws_agent_app: FastAPI, pg_url: str
) -> None:
    with TestClient(ws_agent_app) as tc:
        owner = sign_in_as(tc, pg_url, username="logan", roles=("editor",))
        stranger = sign_in_as(tc, pg_url, username="maya", roles=("editor",))
        governor = sign_in_as(tc, pg_url, username="gov", roles=("root",))
        conversation_id = open_conversation(tc, headers=owner)
        mine = open_conversation(tc, headers=stranger)
        owner_id = tc.get("/users/me", headers=owner).json()["user"]["id"]
        asyncio.run(_seed_file(pg_url, f"{owner_id}/{conversation_id}", "提纲.md", "三幕"))

        with (
            tc.websocket_connect("/ws", headers=governor) as gov_ws,
            tc.websocket_connect("/ws", headers=stranger) as other_ws,
        ):
            assert gov_ws.receive_json()["type"] == "server_hello"
            assert other_ws.receive_json()["type"] == "server_hello"
            subscribe(gov_ws, conversation_id, grade="turn")
            assert until(gov_ws, "transcript.reset")["session_id"] == conversation_id
            subscribe(other_ws, conversation_id, grade="off", frame_id="theirs")
            assert until(other_ws, "ack")["payload"]["not_found"] == [conversation_id]

            sent = tc.post(
                f"/conversations/{conversation_id}/prompts",
                json={"prompt_id": "prm_gov_watch", "content": [{"type": "text", "text": "走"}]},
                headers=owner,
            )
            assert sent.status_code == 200, sent.text
            busy = until(gov_ws, "event.session.work_changed")
            assert (busy["session_id"], busy["payload"]["busy"]) == (conversation_id, True)
            idle = until(gov_ws, "event.session.work_changed")
            assert idle["payload"]["busy"] is False

            renamed = tc.patch(
                f"/conversations/{conversation_id}", json={"title": "改了名"}, headers=owner
            )
            assert renamed.status_code == 200, renamed.text
            title = until(gov_ws, "session.meta.updated")
            assert (title["session_id"], title["payload"]) == (conversation_id, {"title": "改了名"})

            written = tc.put(
                f"/conversations/{conversation_id}/workspace/file",
                json={"path": "提纲.md", "content": "四幕", "expectedVersion": 1},
                headers=owner,
            )
            assert written.status_code == 200, written.text
            changed = until(gov_ws, "event.fs.changed")
            assert changed["session_id"] == conversation_id

            subscribe(other_ws, mine, grade="off", frame_id="w-mine")
            frame = other_ws.receive_json()
            while frame["type"] == "ping":
                frame = other_ws.receive_json()
            assert (frame["type"], frame["id"]) == ("ack", "w-mine")
