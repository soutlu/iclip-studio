"""浏览器连接经后端转到运行时：回执一帧一个、运行时的帧原文转发（多了字段也照转）、事件流上新加的字段与
帧不断连接、两条上游各自断开与事件流重新连上时的关闭码、溢出后连接照常收尾、文件变化经对话内容流原样到达
订着的连接，以及活动与轮次收尾分走两条上游时客户端看得到的先后。"""

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
from agent_runtime.client import (
    EventStream,
    RawFrame,
    RuntimeClient,
    StreamClosed,
    TranscriptChannel,
)
from agent_runtime.harness.transcript.store import TranscriptStore
from agent_runtime.live.frames import Ping, PingPayload, timestamp_now
from agent_runtime.plugins.base import PluginHost, PluginRegistry
from agent_runtime.transcript.wire import Envelope
from fastapi import FastAPI
from sqlalchemy import text
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from iclip.domains.agents.transcript_api import MAX_EVENT_BUFFER, LiveConnections
from iclip.domains.conversations.service import ConversationService
from iclip.domains.identity.public import Principal
from tests.helpers.agents import AgentSeed
from tests.helpers.film import FILM, GIVEN_IMAGES, RUN
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
"""挂着测试插件 ``jotting`` 的 agent：替身模型调它一次，往工作区写 ``notes.md``。"""


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
    """收这段对话的帧，直到这一轮在 transcript 上收了尾、活动也回到空闲。"""

    frames: list[dict[str, Any]] = []
    turn_ended = idle = False
    for _ in range(200):
        frame: dict[str, Any] = ws.receive_json()
        if frame.get("session_id") != conversation_id:
            continue
        frames.append(frame)
        if frame["type"] == "transcript.ops" and any(
            op["op"] == "turn.upsert" and op["turn"]["state"] != "running"
            for op in frame["payload"]["ops"]
        ):
            turn_ended = True
        if frame["type"] == "event.session.work_changed" and not frame["payload"]["busy"]:
            idle = True
        if turn_ended and idle:
            return frames
    raise AssertionError("没等到这一轮收尾与空闲两帧")


def _closed_with(ws: Any) -> int:
    """收帧直到连接被关，交回关闭码。"""

    for _ in range(200):
        try:
            ws.receive_json()
        except WebSocketDisconnect as closed:
            return closed.code
    raise AssertionError("连接没被关")


# --- 回执 ----------------------------------------------------------------------


def test_each_subscribe_frame_gets_exactly_one_ack(ws_agent_app: FastAPI, pg_url: str) -> None:
    """看得见的转给运行时、由它回执；看不见的与写法不对的就地回 not_found，不转；子代理流不属于这段对话的
    由运行时回 404。每帧 id 只回一个回执。"""

    with TestClient(ws_agent_app) as tc:
        # 别人的对话在运行时那边有会话：要是转了过去，运行时会回 accepted。
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
    # 就地回的与运行时回的是同一种回执。
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


# --- 原样转发 --------------------------------------------------------------------


def _wire(frame: Any) -> dict[str, Any]:
    """帧在 WebSocket 上的样子：原文帧就是它的原文，解析过的帧与运行时和后端发帧时的序列化相同。"""

    raw = (
        frame.text
        if isinstance(frame, RawFrame)
        else frame.model_dump_json(exclude_none=True, by_alias=True)
    )
    sent: dict[str, Any] = json.loads(raw)
    return sent


def test_relayed_frames_are_the_runtimes_frames_field_for_field(
    ws_agent_app: FastAPI, pg_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """浏览器收到的 reset / ops 与活动帧，和后端从运行时收到的那一帧逐字段相同，先后也相同：后端只决定发给谁。"""

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
    # 两条上游各自按序转发；浏览器停在收尾与空闲之后，运行时可能已经多发了几帧。
    for kind in (("transcript.reset", "transcript.ops"), ("event.session.work_changed",)):
        browser = [frame for frame in received if frame["type"] in kind]
        runtime = [frame for frame in sent if frame["type"] in kind]
        assert browser == runtime[: len(browser)]


# --- 运行时先于后端升级 ------------------------------------------------------------

_RUNTIME_SEND = "agent_runtime.http.streams._Channel._send"
"""运行时两条 WebSocket 发帧的那一处；测试在这里改写帧，模拟比后端新的运行时。"""

_TRANSCRIPT_FRAMES = ("transcript.reset", "transcript.ops", "ack")


class _Text:
    """替身帧：运行时发帧时调它的 ``model_dump_json``，拿到的就是这段原文。"""

    def __init__(self, text: str) -> None:
        self._text = text

    def model_dump_json(self, **_: Any) -> str:
        return self._text


def _rewrite_runtime_frames(
    monkeypatch: pytest.MonkeyPatch, rewrite: Callable[[dict[str, Any]], tuple[str, ...] | None]
) -> None:
    """运行时每发一帧先交给 ``rewrite``：返回 None 照发原帧，否则依次发它给的原文。"""

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
    """外层与 ``payload`` 里各多一个后端不认识的字段；序列化的写法也与运行时不同，原文对得上才是没重新序列化。"""

    extended = {**wire, "added_later": {"nested": [1, 2]}}
    if isinstance(wire.get("payload"), dict):
        extended["payload"] = {**wire["payload"], "also_added": True}
    return json.dumps(extended, ensure_ascii=False)


def _ack(ws: Any, frame_id: str) -> dict[str, Any]:
    """等这一帧订阅的回执，跳过期间的其他帧。"""

    for _ in range(200):
        frame: dict[str, Any] = ws.receive_json()
        if frame["type"] == "ack" and frame["id"] == frame_id:
            return frame
    raise AssertionError(f"没等到 {frame_id} 的回执")


def test_runtime_frames_with_unknown_fields_reach_the_browser_verbatim(
    ws_agent_app: FastAPI, pg_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """对话内容流的帧多了后端不认识的字段：浏览器收到的就是运行时发的那段原文，连接不断。"""

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
            # 连接还在：再订一段看不见的对话，照常回执。
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
    """事件流上的活动多了字段、还多了后端不认识的帧：认得的照常转成全局帧，认不出的跳过，不当成断线去关
    浏览器连接。"""

    def extend(wire: dict[str, Any]) -> tuple[str, ...] | None:
        if wire["type"] != "event.session.work_changed":
            return None
        novel = {"type": "event.session.something_new", "session_id": wire["session_id"]}
        return (json.dumps(novel), _extended(wire))

    _rewrite_runtime_frames(monkeypatch, extend)
    with TestClient(ws_agent_app) as tc:
        sign_in(tc, pg_url)
        conversation_id = open_conversation(tc)
        with tc.websocket_connect("/ws") as ws:
            assert ws.receive_json()["type"] == "server_hello"
            subscribe(ws, conversation_id)
            until(ws, "transcript.reset")
            _send(tc, conversation_id, "prm_events_extended")
            frames = _frames_until_turn_and_idle(ws, conversation_id)
            subscribe(ws, str(uuid.uuid4()), frame_id="probe")
            _ack(ws, "probe")
        settled(tc, conversation_id)

    work = [frame for frame in frames if frame["type"] == "event.session.work_changed"]
    assert (work[0]["payload"]["busy"], work[-1]["payload"]["busy"]) == (True, False)
    assert not any(frame["type"] == "event.session.something_new" for frame in frames)


# --- 活动与轮次收尾的先后 ------------------------------------------------------------


def test_after_the_turn_ends_and_the_badge_goes_idle_the_row_reads_idle(
    ws_agent_app: FastAPI, pg_url: str
) -> None:
    """活动走事件流、轮次收尾走对话内容流，两条上游之间不保证先后。前端收到活动变化就按 id 补读这一行，读的
    期间到达的帧在结果回来后重放（conversations.live.ts）：所以要的是活动帧按 忙 → 闲 的顺序到达，并且收到闲
    那一帧之后补读的行已经是空闲。"""

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


# --- 上游断开 --------------------------------------------------------------------


def test_a_dropped_transcript_upstream_closes_the_browser_with_1001_and_releases_the_pins(
    ws_agent_app: FastAPI, pg_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """对话内容流那一头断了：浏览器连接以 1001 关，运行时那边这条连接占着的实时状态放开。"""

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
            # 下一帧到达上游时断开。
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
    """事件流断了：此刻的每条浏览器连接都以 1001 关（断线期间的活动补不回来，客户端重连后重拉）；后端随后
    重连事件流，新连接照常收到活动。"""

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
            # 这一轮的第一条活动到达时事件流断开。
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
    """收帧直到连接被关，交回关闭码；先收到 ``frame_id`` 的回执说明连接没被关。"""

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
    """浏览器的重连比事件流快：断线期间连上、重拉过的连接，在事件流连上时也以 1001 关，重连后重拉补上
    两者之间的活动。"""

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
        # 断开之后的那次重连停在握手前，直到测试放行。
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


# --- 溢出 ------------------------------------------------------------------------


def test_an_overflowed_connection_ends_even_with_a_local_ack_pending(
    ws_agent_app: FastAPI, pg_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """溢出后发送泵以 1013 关了连接、不再取队列，读循环这时正要就地回一个 ``not_found`` 回执：它不等队列空位，
    连接照常收尾，运行时那边这条连接占着的实时状态放开。"""

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
        # 读循环停在核这段对话的可见性上，溢出与关连接在这期间发生。
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
                # 发送泵退出后，转发与广播仍会把队列填满（这里直接填），回执就放不进去了。
                tc.portal.call(offer, MAX_EVENT_BUFFER)
            finally:
                released.set()
            _wait_released(store, conversation_id)


# --- 文件变化 --------------------------------------------------------------------


def test_a_plugin_write_reaches_the_subscribed_browser_as_is(
    ws_agent_app: FastAPI, pg_url: str
) -> None:
    """插件在运行时写工作区，文件帧经这条连接背后的对话内容流原样到浏览器；没订这段对话的连接收不到。"""

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
            # 帧按序入队：旁观的连接此刻订一段别的对话，跳过全局帧与心跳后先到的应是它的回执，
            # 说明前面那帧文件变化没给它。
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
        for url in GIVEN_IMAGES:
            await conn.execute(
                text(
                    "INSERT INTO agent_runtime.materials (namespace, url, kind) "
                    "VALUES (:ns, :url, 'image')"
                ),
                {"ns": namespace, "url": url},
            )


def test_a_film_edit_on_the_page_reaches_the_subscribed_browser(
    ws_agent_app: FastAPI, pg_url: str
) -> None:
    """制作页改画幅：后端经运行时写工程文件，变化同样经对话内容流回到订着这段对话的浏览器连接。"""

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
