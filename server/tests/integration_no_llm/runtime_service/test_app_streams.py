"""运行时服务的两条 WebSocket：对话内容流 ``/v1/ws`` 按 subscribe_v2 订阅、按档位发帧、只认调用方应用自己的
会话，断开时放开全部监听与固定；应用事件流 ``/v1/events`` 按应用分发会话活动与工作区文件变更。"""

from __future__ import annotations

from typing import Any

import pytest
from agent_runtime.harness.transcript.store import TranscriptStore
from pydantic_ai.models import Model

from tests.helpers.app import TEST_MODEL_NAME
from tests.helpers.runtime import calls_then_says, says
from tests.helpers.runtime_service import (
    ADMIN_KEY,
    JOTTED,
    LiveRuntime,
    ops_until_turn_ends,
    receive,
    subscribe,
)


@pytest.fixture
def models() -> dict[str, Model]:
    return {TEST_MODEL_NAME: says("答：走起来")}


def ops_of(frames: list[dict[str, Any]]) -> set[str]:
    return {op["op"] for frame in frames for op in frame["payload"]["ops"]}


# --- 对话内容流 -----------------------------------------------------------------


def test_subscribing_then_running_delivers_a_reset_then_ops(live: LiveRuntime) -> None:
    session = live.open_session()

    with live.connect("/v1/ws") as ws:
        subscribe(ws, session)
        reset = receive(ws, "transcript.reset")
        ack = receive(ws, "ack")
        assert ack == {
            "type": "ack",
            "id": "s1",
            "code": 0,
            "msg": "",
            "payload": {"accepted": [session], "not_found": []},
        }
        # 运行时帧上只有会话与实时流，没有会话事件序号。
        assert set(reset) == {"type", "session_id", "stream_epoch", "payload"}
        assert reset["session_id"] == session
        assert (reset["payload"]["agent_id"], reset["payload"]["seq"]) == ("main", 0)

        live.send(session, "prm_ws")
        frames = ops_until_turn_ends(ws)

    assert [frame["payload"]["seq"] for frame in frames] == list(range(1, len(frames) + 1))
    assert {frame["stream_epoch"] for frame in frames} == {reset["stream_epoch"]}
    assert {"prompt.upsert", "turn.upsert", "append"} <= ops_of(frames)
    # 嵌套的实体与操作按别名（camelCase）。
    assert "turnId" in str(frames)
    assert "turn_id" not in str(frames)
    live.settled(session)


def test_resubscribing_with_the_watermark_replays_only_later_batches(live: LiveRuntime) -> None:
    session = live.open_session()
    live.send(session, "prm_first")
    live.settled(session)

    with live.connect("/v1/ws") as ws:
        subscribe(ws, session)
        reset = receive(ws, "transcript.reset")
        subscribe(
            ws,
            session,
            since=reset["payload"]["seq"] - 1,
            epoch=reset["stream_epoch"],
            frame_id="s2",
        )
        replayed = receive(ws, "transcript.ops")
        subscribe(ws, session, since=99999, frame_id="s3")
        stale = receive(ws, "transcript.reset")

    assert replayed["payload"]["seq"] == reset["payload"]["seq"]
    assert stale["payload"]["seq"] == reset["payload"]["seq"]


def test_the_turn_grade_carries_turns_but_no_deltas(live: LiveRuntime) -> None:
    session = live.open_session()

    with live.connect("/v1/ws") as ws:
        subscribe(ws, session, grade="turn")
        receive(ws, "transcript.reset")
        live.send(session, "prm_turn")
        kinds = ops_of(ops_until_turn_ends(ws))

    assert "turn.upsert" in kinds
    assert kinds.isdisjoint({"append", "frame.upsert", "step.upsert"})
    live.settled(session)


def test_the_block_grade_carries_steps_but_no_appends(live: LiveRuntime) -> None:
    session = live.open_session()

    with live.connect("/v1/ws") as ws:
        subscribe(ws, session, grade="block")
        receive(ws, "transcript.reset")
        live.send(session, "prm_block")
        kinds = ops_of(ops_until_turn_ends(ws))

    assert {"turn.upsert", "frame.upsert"} <= kinds
    assert "append" not in kinds
    live.settled(session)


def test_the_off_grade_sends_nothing_and_raising_it_resets(live: LiveRuntime) -> None:
    session = live.open_session()

    with live.connect("/v1/ws") as ws:
        subscribe(ws, session, grade="off")
        # off 不发 reset，第一帧就是回执。
        assert ws.receive_json()["type"] == "ack"
        live.send(session, "prm_off")
        live.settled(session)

        subscribe(ws, session, grade="turn", frame_id="s2")
        first = ws.receive_json()
        subscribe(ws, session, grade="delta", since=1, frame_id="s3")
        raised = receive(ws, "transcript.reset")

    # 静默期间的批次都没发，订阅后的第一帧是 reset。
    assert first["type"] == "transcript.reset"
    assert raised["session_id"] == session


def test_a_child_stream_of_an_unknown_agent_is_refused(live: LiveRuntime) -> None:
    session = live.open_session()

    with live.connect("/v1/ws") as ws:
        subscribe(ws, session, agent="director-deadbeef")
        refused = receive(ws, "ack")
        subscribe(ws, session, frame_id="s2")
        still_open = receive(ws, "transcript.reset")

    assert (refused["code"], refused["msg"]) == (404, "agent not in session: director-deadbeef")
    assert still_open["session_id"] == session


@pytest.mark.parametrize("which", ["other_app", "missing", "not_a_uuid"])
def test_sessions_the_app_does_not_own_are_not_found(live: LiveRuntime, which: str) -> None:
    asked = {
        "other_app": live.open_session(ADMIN_KEY),
        "missing": "4c3b2a19-0f8e-4d7c-b6a5-948372615041",
        "not_a_uuid": "not-a-session",
    }[which]

    with live.connect("/v1/ws") as ws:
        subscribe(ws, asked)
        ack = receive(ws, "ack")

    assert ack["payload"] == {"accepted": [], "not_found": [asked]}


def test_disconnecting_releases_every_pin_and_listener(live: LiveRuntime) -> None:
    store: TranscriptStore = live.app.state.transcript_store
    first, second = live.open_session(), live.open_session()

    with live.connect("/v1/ws") as ws:
        subscribe(ws, first)
        receive(ws, "ack")
        ws.send_json(
            {
                "type": "subscribe_v2",
                "id": "s2",
                "payload": {"session_id": second, "transcript": {"main": "turn", "*": "off"}},
            }
        )
        receive(ws, "ack")
        assert store.holds(first)
        assert store.holds(second)

    assert not store.holds(first)
    assert not store.holds(second)


def test_unsubscribing_releases_the_session(live: LiveRuntime) -> None:
    store: TranscriptStore = live.app.state.transcript_store
    session = live.open_session()

    with live.connect("/v1/ws") as ws:
        subscribe(ws, session)
        receive(ws, "ack")
        ws.send_json({"type": "unsubscribe_v2", "id": "u1", "payload": {"session_id": session}})
        assert receive(ws, "ack")["id"] == "u1"
        assert not store.holds(session)


# --- 应用事件流 -----------------------------------------------------------------


def activities_until_idle(ws: Any, session: str, *, tries: int = 60) -> list[dict[str, Any]]:
    seen: list[dict[str, Any]] = []
    for _ in range(tries):
        frame: dict[str, Any] = ws.receive_json()
        if frame["type"] != "session.activity" or frame["session_id"] != session:
            continue
        seen.append(frame)
        if not frame["activity"]["busy"]:
            return seen
    raise AssertionError("没等到空闲")


def test_session_activity_arrives_busy_then_idle_and_only_to_its_app(live: LiveRuntime) -> None:
    session = live.open_session()
    other_session = live.open_session(ADMIN_KEY)

    with live.connect("/v1/events") as events, live.connect("/v1/events", ADMIN_KEY) as other:
        live.send(session, "prm_events")
        seen = activities_until_idle(events, session)
        # 另一个应用自己的事件排在被测应用的事件之后（分发只有一条队列）：它收到的第一帧是自己的，
        # 说明前面那些一帧都没给它。
        put = live.tc.put(
            f"/v1/sessions/{other_session}/files/mine.md",
            json={"content": "别的应用"},
            headers=live.headers(ADMIN_KEY),
        )
        assert put.status_code == 200, put.text
        first_of_other = other.receive_json()

    assert [frame["activity"] for frame in seen] == [
        {"busy": True, "pending_interaction": "none"},
        {"busy": False, "pending_interaction": "none", "last_turn_reason": "completed"},
    ]
    assert {frame["owner_user_id"] for frame in seen} == {str(live.owner)}
    assert (first_of_other["type"], first_of_other["session_id"]) == ("fs.changed", other_session)


def test_a_files_put_announces_created_then_modified(live: LiveRuntime) -> None:
    session = live.open_session()
    path = f"/v1/sessions/{session}/files/notes/brief.md"

    with live.connect("/v1/events") as events:
        for content in ("第一版", "第二版"):
            assert live.tc.put(path, json={"content": content}, headers=live.headers()).is_success
        created = receive(events, "fs.changed")
        modified = receive(events, "fs.changed")

    assert created == {
        "type": "fs.changed",
        "session_id": session,
        "owner_user_id": str(live.owner),
        "entries": [{"path": "notes/brief.md", "change": "created"}],
    }
    assert modified["entries"] == [{"path": "notes/brief.md", "change": "modified"}]


class TestAPluginWrite:
    @pytest.fixture
    def models(self) -> dict[str, Model]:
        return {TEST_MODEL_NAME: calls_then_says("jot", "记好了")}

    @pytest.fixture
    def live_agent_plugins(self) -> tuple[str, ...]:
        return ("jotting",)

    def test_is_announced_on_the_event_stream(self, live: LiveRuntime) -> None:
        session = live.open_session()

        with live.connect("/v1/events") as events:
            live.send(session, "prm_jot")
            changed = receive(events, "fs.changed")

        assert changed["session_id"] == session
        assert changed["entries"] == [{"path": JOTTED, "change": "created"}]
        live.settled(session)
        assert live.status(session) == "completed"
