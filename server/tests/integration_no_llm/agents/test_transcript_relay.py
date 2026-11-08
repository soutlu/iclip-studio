from __future__ import annotations

import asyncio
import json
import pkgutil
import threading
import uuid
from collections.abc import AsyncGenerator, Callable
from contextlib import asynccontextmanager
from typing import Any

import pytest
from agent_runtime.harness.transcript.store import TranscriptStore
from agent_runtime.plugins.base import PluginHost, PluginRegistry
from agent_runtime.transcript.wire import Envelope
from fastapi import FastAPI
from sqlalchemy import text
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from iclip.domains.agents.transcript_api import MAX_EVENT_BUFFER, LiveConnections
from iclip.domains.conversations.service import ConversationService
from iclip.domains.identity.public import Principal
from iclip.platform.runtime_api.client import (
    EventStream,
    RawFrame,
    RuntimeClient,
    StreamClosed,
    TranscriptChannel,
    WorkChangedFrame,
)
from iclip.platform.runtime_api.live.frames import Ping, PingPayload, timestamp_now
from tests.helpers.agents import AgentSeed
from tests.helpers.film import FILM, RUN
from tests.helpers.pg import connected
from tests.helpers.runtime_backed import standard_plugins
from tests.helpers.runtime_service import JOTTED, JottingPlugin
from tests.helpers.ws import (
    AGENT_ID,
    open_conversation,
    settled,
    sign_in,
    sign_in_as,
    subscribe,
    until,
)

JOTTER = "jotter"


@pytest.fixture
def agent_seeds() -> tuple[AgentSeed, ...]:
    return (AgentSeed(AGENT_ID), AgentSeed(JOTTER, plugins=("jotting",)))


@pytest.fixture
def runtime_plugins() -> Any:
    def bind(host: PluginHost) -> PluginRegistry:
        return {**standard_plugins(host), "jotting": JottingPlugin.bind(files=host.files)}

    return bind


def _send(tc: TestClient, conversation_id: str, prompt_id: str) -> None:
    sent = tc.post(
        f"/conversations/{conversation_id}/prompts",
        json={"prompt_id": prompt_id, "content": [{"type": "text", "text": "走"}]},
    )
    assert sent.status_code == 200, sent.text


def _frames_until_turn_and_idle(ws: Any, conversation_id: str) -> list[dict[str, Any]]:
    return [json.loads(raw) for raw in _texts_until_turn_and_idle(ws, conversation_id)]


def _texts_until_turn_and_idle(ws: Any, conversation_id: str) -> list[str]:
    texts: list[str] = []
    turn_ended = idle = False
    for _ in range(200):
        raw: str = ws.receive_text()
        frame: dict[str, Any] = json.loads(raw)
        if frame.get("session_id") != conversation_id:
            continue
        texts.append(raw)
        if frame["type"] == "transcript.ops" and any(
            op["op"] == "turn.upsert" and op["turn"]["state"] != "running"
            for op in frame["payload"]["ops"]
        ):
            turn_ended = True
        if frame["type"] == "event.session.work_changed" and not frame["payload"]["busy"]:
            idle = True
        if turn_ended and idle:
            return texts
    raise AssertionError("没等到这一轮收尾与空闲两帧")


def _closed_with(ws: Any) -> int:
    for _ in range(200):
        try:
            ws.receive_json()
        except WebSocketDisconnect as closed:
            return closed.code
    raise AssertionError("连接没被关")


def test_each_subscribe_frame_gets_exactly_one_ack(ws_agent_app: FastAPI, pg_url: str) -> None:
    with TestClient(ws_agent_app) as tc:
        theirs = open_conversation(
            tc, sign_in_as(tc, pg_url, username="someone", roles=("editor",))
        )
        me = sign_in_as(tc, pg_url, username="logan", roles=("editor",))
        mine = open_conversation(tc, me)
        missing = str(uuid.uuid4())
        with tc.websocket_connect("/ws", headers=me) as ws:
            assert ws.receive_json()["type"] == "server_hello"
            subscribe(ws, mine, frame_id="visible")
            subscribe(ws, theirs, frame_id="invisible")
            subscribe(ws, missing, frame_id="missing")
            subscribe(ws, "not-a-uuid", frame_id="malformed")
            ws.send_json(
                {
                    "type": "subscribe_v2",
                    "id": "stranger",
                    "payload": {"session_id": mine, "transcript": {"run-nobody": "delta"}},
                }
            )
            subscribe(ws, mine, frame_id="last")

            acks: dict[str, list[dict[str, Any]]] = {}
            while "last" not in acks:
                frame = ws.receive_json()
                if frame["type"] == "ack":
                    acks.setdefault(frame["id"], []).append(frame)

    assert {key: len(found) for key, found in acks.items()} == {
        "visible": 1,
        "invisible": 1,
        "missing": 1,
        "malformed": 1,
        "stranger": 1,
        "last": 1,
    }
    assert acks["visible"][0]["payload"]["accepted"] == [mine]
    assert acks["invisible"][0] == {
        "type": "ack",
        "id": "invisible",
        "code": 0,
        "msg": "",
        "payload": {"accepted": [], "not_found": [theirs]},
    }
    assert set(acks["visible"][0]) == set(acks["invisible"][0])
    assert acks["missing"][0]["payload"]["not_found"] == [missing]
    assert acks["malformed"][0]["payload"]["not_found"] == ["not-a-uuid"]
    assert (acks["stranger"][0]["code"], acks["stranger"][0]["msg"]) == (
        404,
        "agent not in session: run-nobody",
    )


def _wire(frame: Any) -> dict[str, Any]:
    raw = (
        frame.text
        if isinstance(frame, RawFrame | WorkChangedFrame)
        else frame.model_dump_json(exclude_none=True, by_alias=True)
    )
    sent: dict[str, Any] = json.loads(raw)
    return sent


def test_relayed_frames_are_the_runtimes_frames_field_for_field(
    ws_agent_app: FastAPI, pg_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    from_runtime: list[dict[str, Any]] = []
    receive = TranscriptChannel.receive
    following = EventStream.__anext__

    async def recording_receive(channel: TranscriptChannel) -> Any:
        frame = await receive(channel)
        from_runtime.append(_wire(frame))
        return frame

    async def recording_next(stream: EventStream) -> Any:
        event = await following(stream)
        from_runtime.append(_wire(event))
        return event

    monkeypatch.setattr(TranscriptChannel, "receive", recording_receive)
    monkeypatch.setattr(EventStream, "__anext__", recording_next)
    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        conversation_id = open_conversation(tc)
        with tc.websocket_connect("/ws") as ws:
            assert ws.receive_json()["type"] == "server_hello"
            subscribe(ws, conversation_id)
            reset = until(ws, "transcript.reset")
            _send(tc, conversation_id, "prm_verbatim")
            frames = [reset, *_frames_until_turn_and_idle(ws, conversation_id)]

    relayed = ("transcript.reset", "transcript.ops", "event.session.work_changed")
    received = [frame for frame in frames if frame["type"] in relayed]
    sent = [
        frame
        for frame in from_runtime
        if frame["type"] in relayed and frame["session_id"] == conversation_id
    ]
    assert {frame["type"] for frame in received} == set(relayed)
    for kind in (("transcript.reset", "transcript.ops"), ("event.session.work_changed",)):
        browser = [frame for frame in received if frame["type"] in kind]
        runtime = [frame for frame in sent if frame["type"] in kind]
        assert browser == runtime[: len(browser)]


_RUNTIME_SEND = "agent_runtime.http.streams._Channel._send"

_TRANSCRIPT_FRAMES = ("transcript.reset", "transcript.ops", "ack")


class _Text:
    def __init__(self, text: str) -> None:
        self._text = text

    def model_dump_json(self, **_: Any) -> str:
        return self._text


def _rewrite_runtime_frames(
    monkeypatch: pytest.MonkeyPatch, rewrite: Callable[[dict[str, Any]], tuple[str, ...] | None]
) -> None:
    original = pkgutil.resolve_name(_RUNTIME_SEND)

    async def send(channel: Any, frame: Envelope) -> None:
        texts = rewrite(_wire(frame))
        if texts is None:
            await original(channel, frame)
            return
        for raw in texts:
            await original(channel, _Text(raw))

    monkeypatch.setattr(_RUNTIME_SEND, send)


def _extended(wire: dict[str, Any]) -> str:
    extended = {**wire, "added_later": {"nested": [1, 2]}}
    if isinstance(wire.get("payload"), dict):
        extended["payload"] = {**wire["payload"], "also_added": True}
    return json.dumps(extended, ensure_ascii=False)


def _ack(ws: Any, frame_id: str) -> dict[str, Any]:
    for _ in range(200):
        frame: dict[str, Any] = ws.receive_json()
        if frame["type"] == "ack" and frame["id"] == frame_id:
            return frame
    raise AssertionError(f"没等到 {frame_id} 的回执")


def test_runtime_frames_with_unknown_fields_reach_the_browser_verbatim(
    ws_agent_app: FastAPI, pg_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    sent: list[str] = []

    def extend(wire: dict[str, Any]) -> tuple[str, ...] | None:
        if wire["type"] not in _TRANSCRIPT_FRAMES:
            return None
        sent.append(_extended(wire))
        return (sent[-1],)

    _rewrite_runtime_frames(monkeypatch, extend)
    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        conversation_id = open_conversation(tc)
        with tc.websocket_connect("/ws") as ws:
            assert ws.receive_json()["type"] == "server_hello"
            subscribe(ws, conversation_id)
            _send(tc, conversation_id, "prm_extended")
            received: list[str] = []
            while True:
                raw = ws.receive_text()
                frame = json.loads(raw)
                if frame["type"] not in _TRANSCRIPT_FRAMES:
                    continue
                received.append(raw)
                if frame["type"] == "transcript.ops" and any(
                    op["op"] == "turn.upsert" and op["turn"]["state"] != "running"
                    for op in frame["payload"]["ops"]
                ):
                    break
            missing = str(uuid.uuid4())
            subscribe(ws, missing, frame_id="probe")
            probe = _ack(ws, "probe")
        settled(tc, conversation_id)

    assert {json.loads(raw)["type"] for raw in received} == set(_TRANSCRIPT_FRAMES)
    assert received == sent[: len(received)]
    assert probe["payload"]["not_found"] == [missing]


def test_added_event_fields_and_types_do_not_close_browser_connections(
    ws_agent_app: FastAPI, pg_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    sent: list[str] = []

    def extend(wire: dict[str, Any]) -> tuple[str, ...] | None:
        if wire["type"] != "event.session.work_changed":
            return None
        novel = {"type": "event.session.something_new", "session_id": wire["session_id"]}
        sent.append(_extended(wire))
        return (json.dumps(novel), sent[-1])

    _rewrite_runtime_frames(monkeypatch, extend)
    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        conversation_id = open_conversation(tc)
        with tc.websocket_connect("/ws") as ws:
            assert ws.receive_json()["type"] == "server_hello"
            subscribe(ws, conversation_id)
            until(ws, "transcript.reset")
            _send(tc, conversation_id, "prm_events_extended")
            texts = _texts_until_turn_and_idle(ws, conversation_id)
            subscribe(ws, str(uuid.uuid4()), frame_id="probe")
            _ack(ws, "probe")
        settled(tc, conversation_id)

    frames = [json.loads(raw) for raw in texts]
    work = [raw for raw in texts if json.loads(raw)["type"] == "event.session.work_changed"]
    mine = [raw for raw in sent if json.loads(raw)["session_id"] == conversation_id]
    assert work == mine[: len(work)]
    assert (json.loads(work[0])["payload"]["busy"], json.loads(work[-1])["payload"]["busy"]) == (
        True,
        False,
    )
    assert not any(frame["type"] == "event.session.something_new" for frame in frames)


def test_after_the_turn_ends_and_the_badge_goes_idle_the_row_reads_idle(
    ws_agent_app: FastAPI, pg_url: str
) -> None:
    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        conversation_id = open_conversation(tc)
        with tc.websocket_connect("/ws") as ws:
            assert ws.receive_json()["type"] == "server_hello"
            subscribe(ws, conversation_id)
            until(ws, "transcript.reset")
            _send(tc, conversation_id, "prm_order")
            frames = _frames_until_turn_and_idle(ws, conversation_id)
            row = tc.get(f"/conversations/{conversation_id}").json()["conversation"]

    work = [frame for frame in frames if frame["type"] == "event.session.work_changed"]
    assert work[0]["payload"]["busy"] is True
    assert work[-1]["payload"]["busy"] is False
    assert work[-1]["payload"]["last_turn_reason"] == "completed"
    assert row["activity"]["busy"] is False
    assert row["activity"]["lastTurnReason"] == "completed"


def test_a_dropped_transcript_upstream_closes_the_browser_with_1001_and_releases_the_pins(
    ws_agent_app: FastAPI, pg_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    dropping = threading.Event()
    receive = TranscriptChannel.receive

    async def flaky(channel: TranscriptChannel) -> Any:
        frame = await receive(channel)
        if dropping.is_set():
            raise StreamClosed(1012, "测试里断开")
        return frame

    monkeypatch.setattr(TranscriptChannel, "receive", flaky)
    store: TranscriptStore = ws_agent_app.state.transcript_store
    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        conversation_id = open_conversation(tc)
        with tc.websocket_connect("/ws") as ws:
            assert ws.receive_json()["type"] == "server_hello"
            subscribe(ws, conversation_id, frame_id="s1")
            until(ws, "transcript.reset")
            assert store.holds(conversation_id)
            dropping.set()
            subscribe(ws, conversation_id, frame_id="s2")
            assert _closed_with(ws) == 1001
        _wait_released(store, conversation_id)


def _wait_released(store: TranscriptStore, conversation_id: str) -> None:
    for _ in range(100):
        if not store.holds(conversation_id):
            return
        threading.Event().wait(0.02)
    raise AssertionError("运行时那边的实时状态没放开")


def test_a_dropped_event_stream_closes_every_browser_connection_then_reconnects(
    ws_agent_app: FastAPI, pg_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    dropping = threading.Event()
    following = EventStream.__anext__

    async def flaky(stream: EventStream) -> Any:
        event = await following(stream)
        if dropping.is_set():
            dropping.clear()
            raise StreamClosed(1012, "测试里断开")
        return event

    monkeypatch.setattr(EventStream, "__anext__", flaky)
    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        conversation_id = open_conversation(tc)
        with tc.websocket_connect("/ws") as first, tc.websocket_connect("/ws") as second:
            assert first.receive_json()["type"] == "server_hello"
            assert second.receive_json()["type"] == "server_hello"
            dropping.set()
            _send(tc, conversation_id, "prm_drop")
            assert _closed_with(first) == 1001
            assert _closed_with(second) == 1001
        settled(tc, conversation_id)

        events = ws_agent_app.state.runtime_events

        async def reconnected() -> None:
            await asyncio.wait_for(events.wait_connected(), 10)

        assert tc.portal is not None
        tc.portal.call(reconnected)
        with tc.websocket_connect("/ws") as again:
            assert again.receive_json()["type"] == "server_hello"
            _send(tc, conversation_id, "prm_after")
            busy = until(again, "event.session.work_changed")

    assert busy["session_id"] == conversation_id


def _closed_before_ack(ws: Any, frame_id: str) -> int:
    for _ in range(200):
        try:
            frame = ws.receive_json()
        except WebSocketDisconnect as closed:
            return closed.code
        if frame["type"] == "ack" and frame["id"] == frame_id:
            raise AssertionError("连接没被关，订阅照常回了执")
    raise AssertionError("连接没被关")


def test_a_browser_connected_while_the_event_stream_was_down_is_closed_when_it_reconnects(
    ws_agent_app: FastAPI, pg_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    dropping = threading.Event()
    holding = threading.Event()
    reconnecting = threading.Event()
    released = threading.Event()
    following = EventStream.__anext__
    connect_events = RuntimeClient.connect_events

    async def flaky(stream: EventStream) -> Any:
        event = await following(stream)
        if dropping.is_set():
            dropping.clear()
            raise StreamClosed(1012, "测试里断开")
        return event

    @asynccontextmanager
    async def held(client: RuntimeClient) -> AsyncGenerator[EventStream]:
        if holding.is_set():
            reconnecting.set()
            while not released.is_set():
                await asyncio.sleep(0.01)
        async with connect_events(client) as events:
            yield events

    monkeypatch.setattr(EventStream, "__anext__", flaky)
    monkeypatch.setattr(RuntimeClient, "connect_events", held)
    events = ws_agent_app.state.runtime_events

    async def reconnected() -> None:
        await asyncio.wait_for(events.wait_connected(), 10)

    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        conversation_id = open_conversation(tc)
        holding.set()
        dropping.set()
        with tc.websocket_connect("/ws") as before:
            assert before.receive_json()["type"] == "server_hello"
            _send(tc, conversation_id, "prm_drop")
            assert _closed_with(before) == 1001
        assert reconnecting.wait(10), "事件流没有开始重连"
        try:
            with tc.websocket_connect("/ws") as during:
                assert during.receive_json()["type"] == "server_hello"
                released.set()
                assert tc.portal is not None
                tc.portal.call(reconnected)
                subscribe(during, str(uuid.uuid4()), frame_id="probe")
                assert _closed_before_ack(during, "probe") == 1001
        finally:
            released.set()
        settled(tc, conversation_id)


def test_an_overflowed_connection_ends_even_with_a_local_ack_pending(
    ws_agent_app: FastAPI, pg_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    connections: list[Any] = []
    add = LiveConnections.add
    agent_of = ConversationService.agent_of
    blocked = str(uuid.uuid4())
    looking_up = threading.Event()
    released = threading.Event()

    def recording_add(live: LiveConnections, connection: Any) -> None:
        connections.append(connection)
        add(live, connection)

    async def held_agent_of(
        service: ConversationService, principal: Principal, conversation_id: str, *, writing: bool
    ) -> str:
        if conversation_id == blocked:
            looking_up.set()
            while not released.is_set():
                await asyncio.sleep(0.01)
        return await agent_of(service, principal, conversation_id, writing=writing)

    monkeypatch.setattr(LiveConnections, "add", recording_add)
    monkeypatch.setattr(ConversationService, "agent_of", held_agent_of)
    store: TranscriptStore = ws_agent_app.state.transcript_store

    def offer(times: int) -> None:
        [connection] = connections
        for _ in range(times):
            connection.offer(Ping(timestamp=timestamp_now(), payload=PingPayload(nonce="fill")))

    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        conversation_id = open_conversation(tc)
        with tc.websocket_connect("/ws") as ws:
            assert ws.receive_json()["type"] == "server_hello"
            subscribe(ws, conversation_id, frame_id="s1")
            _ack(ws, "s1")
            assert store.holds(conversation_id)
            subscribe(ws, blocked, frame_id="held")
            try:
                assert looking_up.wait(10), "读循环没有去核可见性"
                assert tc.portal is not None
                tc.portal.call(offer, MAX_EVENT_BUFFER + 1)
                assert _closed_with(ws) == 1013
                tc.portal.call(offer, MAX_EVENT_BUFFER)
            finally:
                released.set()
            _wait_released(store, conversation_id)


def test_a_plugin_write_reaches_the_subscribed_browser_as_is(
    ws_agent_app: FastAPI, pg_url: str
) -> None:
    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        created = tc.post("/conversations", json={"agentId": JOTTER})
        assert created.status_code == 201, created.text
        conversation_id = str(created.json()["conversation"]["id"])
        with tc.websocket_connect("/ws") as ws, tc.websocket_connect("/ws") as bystander:
            assert ws.receive_json()["type"] == "server_hello"
            assert bystander.receive_json()["type"] == "server_hello"
            subscribe(ws, conversation_id, grade="turn")
            assert until(ws, "ack")["payload"]["accepted"] == [conversation_id]
            _send(tc, conversation_id, "prm_jot")
            changed = until(ws, "event.fs.changed", tries=200)
            settled(tc, conversation_id)
            subscribe(bystander, open_conversation(tc), grade="off", frame_id="probe")
            bystander_first = next(
                frame
                for frame in iter(bystander.receive_json, None)
                if frame["type"] in {"ack", "event.fs.changed"}
            )

    assert set(changed) == {"type", "session_id", "timestamp", "payload"}
    assert changed["session_id"] == conversation_id
    assert changed["payload"] == {"changes": [{"path": JOTTED, "change": "created"}]}
    assert (bystander_first["type"], bystander_first["id"]) == ("ack", "probe")


async def _seed_film(pg_url: str, namespace: str) -> None:
    async with connected(pg_url) as conn:
        for path, content in (("film.icml", FILM), ("film.icrun", RUN)):
            await conn.execute(
                text(
                    "INSERT INTO agent_runtime.workspace_files "
                    "(namespace, path, content, version, created_at, updated_at) "
                    "VALUES (:ns, :path, :content, 1, now(), now())"
                ),
                {"ns": namespace, "path": path, "content": content},
            )


def test_a_film_edit_on_the_page_reaches_the_subscribed_browser(
    ws_agent_app: FastAPI, pg_url: str
) -> None:
    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        conversation_id = open_conversation(tc)
        owner = tc.get("/users/me").json()["user"]["id"]
        asyncio.run(_seed_film(pg_url, f"{owner}/{conversation_id}"))
        with tc.websocket_connect("/ws") as ws:
            assert ws.receive_json()["type"] == "server_hello"
            subscribe(ws, conversation_id, grade="off")
            assert until(ws, "ack")["payload"]["accepted"] == [conversation_id]
            edited = tc.put(
                f"/conversations/{conversation_id}/film/aspect-ratio",
                json={"filmVersion": 1, "aspectRatio": "9:16"},
            )
            assert edited.status_code == 200, edited.text
            changed = until(ws, "event.fs.changed")

    assert changed["payload"]["changes"] == [{"path": "film.icml", "change": "modified"}]
