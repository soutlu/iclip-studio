"""客户端库的两条 WebSocket：对话内容流交出帧的原文、事件流把会话活动解析成 ``live.frames`` 的类型，两边都
容忍运行时新加的字段与帧；``ping`` 自动回同 ``nonce`` 的 ``pong``、运行时关连接抛带关闭码的 ``StreamClosed``、
认不出应用是 ``AppRejected``、帧读不出类型或认得的帧解析不了是 ``RuntimeUnavailable``。

对面是测试里的一个小 Starlette 应用，按脚本发帧、收帧、关连接，经 ``ASGIWebSocketTransport`` 接上，不碰库。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest
from httpx_ws.transport import ASGIWebSocketTransport
from starlette.applications import Starlette
from starlette.routing import WebSocketRoute
from starlette.websockets import WebSocket, WebSocketDisconnect

from agent_runtime.client import (
    AppRejected,
    RawFrame,
    RuntimeClient,
    RuntimeUnavailable,
    StreamClosed,
)
from agent_runtime.live.frames import (
    Ack,
    FsChanged,
    FsChangeEntry,
    FsChangesPayload,
    Ping,
    PingPayload,
    SessionWorkChanged,
    SubscribeAckPayload,
    TranscriptOpsFrame,
    TranscriptResetFrame,
)
from agent_runtime.transcript.ops import TranscriptSnapshot
from agent_runtime.transcript.wire import (
    Envelope,
    OpsPayload,
    ResetPayload,
    SessionActivityOut,
    Subscribe,
    SubscribePayload,
    Unsubscribe,
    UnsubscribePayload,
)

KEY = "app-key-0123456789-0123456789-abcdef"
SESSION = "0b8e9f4c-6a1d-4f2e-9c3b-5d7a1e2f3c4d"
OWNER = "6f1d8a4e-2b7c-4e0a-9d51-3c2f7e8b9a10"

AT = "2026-10-30T08:00:00+00:00"

RESET = TranscriptResetFrame(
    session_id=SESSION,
    timestamp=AT,
    stream_epoch="e1",
    payload=ResetPayload(agent_id="main", snapshot=TranscriptSnapshot(), seq=0),
)
OPS = TranscriptOpsFrame(
    session_id=SESSION,
    timestamp=AT,
    stream_epoch="e1",
    payload=OpsPayload(agent_id="main", ops=(), seq=1),
)
ACTIVITY = SessionWorkChanged(
    session_id=SESSION,
    owner_user_id=OWNER,
    timestamp=AT,
    payload=SessionActivityOut(busy=True, pending_interaction="none"),
)
IDLE = ACTIVITY.model_copy(
    update={"payload": SessionActivityOut(busy=False, pending_interaction="none")}
)
CHANGED = FsChanged(
    session_id=SESSION,
    timestamp=AT,
    payload=FsChangesPayload(changes=(FsChangeEntry(path="notes.md", change="created"),)),
)


@dataclass(frozen=True)
class Send:
    frame: Envelope | str


@dataclass(frozen=True)
class Expect:
    """等对面发来一帧，记进 ``inbound``。"""


@dataclass(frozen=True)
class Close:
    code: int


Step = Send | Expect | Close


@dataclass
class FakeRuntime:
    """按 ``script`` 一步步走的对面；认不出密钥就在握手前以 1008 关。走完脚本接着收，直到对方断开。"""

    script: list[Step] = field(default_factory=list[Step])
    inbound: list[dict[str, Any]] = field(default_factory=list[dict[str, Any]])
    authorization: list[str | None] = field(default_factory=list[str | None])

    async def endpoint(self, ws: WebSocket) -> None:
        self.authorization.append(ws.headers.get("authorization"))
        if ws.headers.get("authorization") != f"Bearer {KEY}":
            await ws.close(code=1008)
            return
        await ws.accept()
        try:
            for step in self.script:
                if isinstance(step, Send):
                    frame = step.frame
                    await ws.send_text(
                        frame
                        if isinstance(frame, str)
                        else frame.model_dump_json(exclude_none=True, by_alias=True)
                    )
                elif isinstance(step, Expect):
                    self.inbound.append(json.loads(await ws.receive_text()))
                else:
                    await ws.close(code=step.code)
                    return
            while True:
                self.inbound.append(json.loads(await ws.receive_text()))
        except WebSocketDisconnect:
            return


@pytest.fixture
def fake() -> FakeRuntime:
    return FakeRuntime()


def _client(fake: FakeRuntime, key: str = KEY) -> RuntimeClient:
    app = Starlette(
        routes=[
            WebSocketRoute("/v1/ws", fake.endpoint),
            WebSocketRoute("/v1/events", fake.endpoint),
        ]
    )
    return RuntimeClient("http://runtime.test", key, transport=ASGIWebSocketTransport(app))


def _subscribe() -> Subscribe:
    return Subscribe(
        id="s1", payload=SubscribePayload(session_id=SESSION, transcript={"main": "delta"})
    )


def _text(frame: Envelope) -> str:
    """帧在 WebSocket 上的原文，与运行时发帧时的序列化相同。"""

    return frame.model_dump_json(exclude_none=True, by_alias=True)


def _raw(frame: Envelope) -> RawFrame:
    return RawFrame(type=json.loads(_text(frame))["type"], text=_text(frame))


def _with_extra(frame: Envelope) -> str:
    """运行时新版本可能发的样子：外层与 ``payload`` 里各多一个这个客户端不认识的字段。"""

    wire = json.loads(_text(frame))
    wire["added_later"] = {"nested": [1, 2]}
    wire["payload"]["also_added"] = True
    return json.dumps(wire, ensure_ascii=False)


ACK = Ack(id="s1", payload=SubscribeAckPayload(accepted=(SESSION,)))


async def test_transcript_frames_come_as_raw_text_and_pings_are_answered(
    fake: FakeRuntime,
) -> None:
    fake.script = [
        Expect(),
        Send(Ping(timestamp=AT, payload=PingPayload(nonce="n1"))),
        Expect(),
        Send(ACK),
        Send(RESET),
        Send(OPS),
        Send(CHANGED),
        Expect(),
    ]

    async with _client(fake) as client, client.connect_transcript() as channel:
        await channel.subscribe(_subscribe())
        ack = await channel.receive()
        reset = await channel.receive()
        ops = await channel.receive()
        changed = await channel.receive()
        await channel.unsubscribe(
            Unsubscribe(id="u1", payload=UnsubscribePayload(session_id=SESSION))
        )

    assert (ack, reset, ops, changed) == (_raw(ACK), _raw(RESET), _raw(OPS), _raw(CHANGED))
    assert fake.authorization == [f"Bearer {KEY}"]
    assert fake.inbound == [
        {
            "type": "subscribe_v2",
            "id": "s1",
            "payload": {
                "session_id": SESSION,
                "transcript": {"main": "delta"},
                "transcript_since": {},
                "transcript_epoch": {},
            },
        },
        {"type": "pong", "payload": {"nonce": "n1"}},
        {"type": "unsubscribe_v2", "id": "u1", "payload": {"session_id": SESSION, "agent_ids": []}},
    ]


async def test_a_server_close_raises_with_its_close_code(fake: FakeRuntime) -> None:
    fake.script = [Send(Ack(id="s1")), Close(1013)]

    with pytest.raises(StreamClosed) as raised:
        async with _client(fake) as client, client.connect_transcript() as channel:
            assert await channel.receive() == _raw(Ack(id="s1"))
            await channel.receive()

    assert raised.value.code == 1013


async def test_an_unknown_app_key_is_refused_before_the_handshake(fake: FakeRuntime) -> None:
    with pytest.raises(AppRejected) as raised:
        async with _client(fake, key="not-this-app") as client:
            async with client.connect_events():
                pass

    assert not isinstance(raised.value, StreamClosed)
    assert raised.value.status is None
    assert "not-this-app" not in str(raised.value)


@pytest.mark.parametrize("status", [401, 403])
async def test_a_handshake_answered_with_an_app_refusal_status_is_app_rejected(
    status: int,
) -> None:
    """ASGI 服务器替握手前就关的连接代答 HTTP 403，经它连时看到的是这个，不是 1008。"""

    transport = httpx.MockTransport(lambda _r: httpx.Response(status))
    async with RuntimeClient("http://runtime.test", KEY, transport=transport) as client:
        with pytest.raises(AppRejected) as raised:
            async with client.connect_transcript():
                pass

    assert raised.value.status == status
    assert KEY not in str(raised.value)


async def test_a_handshake_answered_with_another_status_is_plain_runtime_unavailable() -> None:
    transport = httpx.MockTransport(lambda _r: httpx.Response(502))
    async with RuntimeClient("http://runtime.test", KEY, transport=transport) as client:
        with pytest.raises(RuntimeUnavailable) as raised:
            async with client.connect_transcript():
                pass

    assert not isinstance(raised.value, AppRejected)
    assert raised.value.status == 502


async def test_transcript_frames_with_fields_or_types_this_client_does_not_know_come_verbatim(
    fake: FakeRuntime,
) -> None:
    """运行时先于应用升级：多出的字段与新的帧类型都照原文交出，连接不断。"""

    extended = _with_extra(RESET)
    novel = '{"type": "transcript.something_new", "session_id": "x", "payload": {}}'
    fake.script = [Send(extended), Send(novel), Send(OPS)]

    async with _client(fake) as client, client.connect_transcript() as channel:
        received = [await channel.receive() for _ in range(3)]

    assert received == [
        RawFrame(type="transcript.reset", text=extended),
        RawFrame(type="transcript.something_new", text=novel),
        _raw(OPS),
    ]


@pytest.mark.parametrize(
    "frame",
    ["not json", '["transcript.ops"]', '{"session_id": "x"}', '{"type": "ping"}'],
    ids=["not-json", "not-an-object", "no-type", "ping-without-nonce"],
)
async def test_a_frame_without_a_readable_type_is_runtime_unavailable(
    fake: FakeRuntime, frame: str
) -> None:
    fake.script = [Send(frame)]

    with pytest.raises(RuntimeUnavailable) as raised:
        async with _client(fake) as client, client.connect_transcript() as channel:
            await channel.receive()

    assert not isinstance(raised.value, StreamClosed)


async def test_events_tolerate_added_fields_and_hand_back_unknown_types_raw(
    fake: FakeRuntime,
) -> None:
    """认得的事件多出字段照样解析（多的忽略），带多余字段的心跳照样回，认不出的类型原文交出、不断流。"""

    novel = '{"type": "event.session.something_new", "session_id": "x"}'
    fake.script = [
        Send(_with_extra(ACTIVITY)),
        Send(_with_extra(Ping(timestamp=AT, payload=PingPayload(nonce="n3")))),
        Expect(),
        Send(novel),
        Send(IDLE),
        Close(1001),
    ]
    received: list[Any] = []

    with pytest.raises(StreamClosed):
        async with _client(fake) as client, client.connect_events() as events:
            async for event in events:
                received.append(event)

    assert received == [ACTIVITY, RawFrame(type="event.session.something_new", text=novel), IDLE]
    assert fake.inbound == [{"type": "pong", "payload": {"nonce": "n3"}}]


async def test_a_known_event_that_does_not_parse_is_runtime_unavailable(fake: FakeRuntime) -> None:
    fake.script = [Send('{"type": "event.session.work_changed", "session_id": "x"}')]

    with pytest.raises(RuntimeUnavailable) as raised:
        async with _client(fake) as client, client.connect_events() as events:
            await anext(events)

    assert not isinstance(raised.value, StreamClosed)


async def test_events_arrive_in_order_with_pings_answered_until_the_close(
    fake: FakeRuntime,
) -> None:
    fake.script = [
        Send(ACTIVITY),
        Send(Ping(timestamp=AT, payload=PingPayload(nonce="n2"))),
        Expect(),
        Send(IDLE),
        Close(1001),
    ]
    received: list[Any] = []

    with pytest.raises(StreamClosed) as raised:
        async with _client(fake) as client, client.connect_events() as events:
            async for event in events:
                received.append(event)

    assert received == [ACTIVITY, IDLE]
    assert fake.inbound == [{"type": "pong", "payload": {"nonce": "n2"}}]
    assert raised.value.code == 1001


async def test_errors_from_the_callers_own_code_come_out_as_themselves(fake: FakeRuntime) -> None:
    class Stop(Exception):
        pass

    with pytest.raises(Stop):
        async with _client(fake) as client, client.connect_transcript():
            raise Stop
