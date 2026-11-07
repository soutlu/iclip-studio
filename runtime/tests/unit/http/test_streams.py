from __future__ import annotations

import asyncio
import time
import uuid
from collections.abc import AsyncGenerator, Callable, Collection, Generator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, cast

import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from cue.errors import NotFound
from cue.harness.transcript.service import TranscriptService
from cue.harness.transcript.store import Listener, OpBatch
from cue.harness.transcript.subscription import SubscribeFrames
from cue.http import streams
from cue.http.auth import build_app_auth
from cue.http.streams import (
    MAX_OUTBOUND,
    create_events_router,
    create_transcript_ws_router,
)
from cue.live.frames import (
    FsChanged,
    FsChangeEntry,
    FsChangesPayload,
    SessionWorkChanged,
)
from cue.live.hub import AppEventHub, FileChangeSink, SessionFileChanges
from cue.service.sessions import SessionService
from cue.settings import ResolvedApp
from cue.transcript.ops import MAIN_AGENT_ID, ItemsRemoveOp, TranscriptSnapshot
from cue.transcript.wire import OpsPayload, ResetPayload, SessionActivityOut

BFF_KEY = "bff-app-key-0123456789-0123456789-ab"
TOOL_KEY = "tool-app-key-0123456789-0123456789-a"
BFF_SESSION = "0b8e9f4c-6a1d-4f2e-9c3b-5d7a1e2f3c4d"
OTHER_BFF_SESSION = "9d2c1b0a-5e4f-4a3b-8c7d-6e5f4a3b2c1d"
TOOL_SESSION = "1a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d"
OWNER = "6f1d8a4e-2b7c-4e0a-9d51-3c2f7e8b9a10"
CHILD = "run-child"
OTHER_CHILD = "run-child-2"
AT = "2026-10-30T08:00:00+00:00"

APPS = {BFF_SESSION: "bff", OTHER_BFF_SESSION: "bff", TOOL_SESSION: "tool"}


@dataclass(frozen=True)
class Route:
    app_id: str
    preview: bool = False


async def route_of(session_id: str) -> Route | None:
    found = APPS.get(session_id)
    return None if found is None else Route(found)


def activity(session_id: str, *, busy: bool) -> SessionWorkChanged:
    return SessionWorkChanged(
        session_id=session_id,
        owner_user_id=OWNER,
        timestamp=AT,
        payload=SessionActivityOut(busy=busy, pending_interaction="none"),
    )


def wrote(session_id: str, path: str = "notes.md") -> FsChanged:
    return FsChanged(
        session_id=session_id,
        timestamp=AT,
        payload=FsChangesPayload(changes=(FsChangeEntry(path=path, change="modified"),)),
    )


class FakeTranscripts:
    def __init__(self) -> None:
        self.pins = 0
        self.listeners: dict[tuple[str, str], Listener] = {}
        self.live_during_subscribe = 0
        self.catchup: dict[str, int] = {}

    async def verify_agent(self, conversation_id: str, agent_id: str) -> None:
        if agent_id not in (MAIN_AGENT_ID, CHILD, OTHER_CHILD):
            raise NotFound(f"agent not in session: {agent_id}")

    def subscribe(
        self, conversation_id: str, *, agent_id: str, since: int | None, epoch: str | None
    ) -> SubscribeFrames:
        listener = self.listeners[(conversation_id, agent_id)]
        for seq in range(1, self.live_during_subscribe + 1):
            listener(OpBatch(seq=seq, ops=(ItemsRemoveOp(ids=("t1",)),), epoch="e1"))
        catchup = self.catchup.get(agent_id, 0)
        if since is not None and catchup:
            batches = tuple(
                OpsPayload(agent_id=agent_id, ops=(ItemsRemoveOp(ids=("t1",)),), seq=since + offset)
                for offset in range(1, catchup + 1)
            )
            return SubscribeFrames(stream_epoch="e1", frames=batches)
        reset = ResetPayload(agent_id=agent_id, snapshot=TranscriptSnapshot(), seq=0)
        return SubscribeFrames(stream_epoch="e1", frames=(reset,))

    def listen(self, conversation_id: str, listener: Listener, *, agent_id: str) -> None:
        self.listeners[(conversation_id, agent_id)] = listener

    def unlisten(self, conversation_id: str, listener: Listener, *, agent_id: str) -> None:
        del self.listeners[(conversation_id, agent_id)]

    def pin(self, conversation_id: str) -> None:
        self.pins += 1

    def unpin(self, conversation_id: str) -> None:
        self.pins -= 1


class FakeSessions:
    def __init__(self) -> None:
        self.delay = 0.0

    async def owned(
        self, session_ids: Collection[uuid.UUID], *, app_id: str
    ) -> frozenset[uuid.UUID]:
        if self.delay:
            await asyncio.sleep(self.delay)
        return frozenset(sid for sid in session_ids if APPS.get(str(sid)) == app_id)


class RecordingFileChanges(SessionFileChanges):
    def __init__(self) -> None:
        super().__init__()
        self.log: list[tuple[str, str]] = []

    def attach(self, session_id: str, sink: FileChangeSink) -> None:
        self.log.append(("attach", session_id))
        super().attach(session_id, sink)

    def detach(self, session_id: str, sink: FileChangeSink) -> None:
        self.log.append(("detach", session_id))
        super().detach(session_id, sink)


@pytest.fixture
def hub() -> AppEventHub:
    return AppEventHub(route_of)


@pytest.fixture
def file_changes() -> RecordingFileChanges:
    return RecordingFileChanges()


@pytest.fixture
def transcripts() -> FakeTranscripts:
    return FakeTranscripts()


@pytest.fixture
def sessions() -> FakeSessions:
    return FakeSessions()


@pytest.fixture
def client(
    hub: AppEventHub,
    file_changes: RecordingFileChanges,
    transcripts: FakeTranscripts,
    sessions: FakeSessions,
) -> Generator[TestClient]:
    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncGenerator[None]:
        await hub.start()
        try:
            yield
        finally:
            await hub.stop()

    app = FastAPI(lifespan=lifespan)
    auth = build_app_auth(
        (
            ResolvedApp(id="bff", key=BFF_KEY, admin=False),
            ResolvedApp(id="tool", key=TOOL_KEY, admin=False),
        )
    )
    app.include_router(create_events_router(auth.identify, hub))
    app.include_router(
        create_transcript_ws_router(
            auth.identify,
            cast(TranscriptService, transcripts),
            cast(SessionService, sessions),
            file_changes,
        )
    )
    with TestClient(app) as tc:
        yield tc


def bearer(key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {key}"}


def in_app_loop(client: TestClient, action: Callable[[], None]) -> None:
    portal = client.portal
    assert portal is not None, "TestClient 要在 with 里用"
    portal.call(action)


def send_subscribe(
    ws: Any,
    session_id: str,
    transcript: dict[str, str],
    *,
    frame_id: str = "s1",
    since: dict[str, int] | None = None,
) -> None:
    payload: dict[str, Any] = {"session_id": session_id, "transcript": transcript}
    if since is not None:
        payload["transcript_since"] = since
        payload["transcript_epoch"] = dict.fromkeys(since, "e1")
    ws.send_json({"type": "subscribe_v2", "id": frame_id, "payload": payload})


def subscribe(
    ws: Any, session_id: str, transcript: dict[str, str], *, frame_id: str = "s1"
) -> dict[str, Any]:
    send_subscribe(ws, session_id, transcript, frame_id=frame_id)
    return until_ack(ws, frame_id)


def unsubscribe(
    ws: Any, session_id: str, agent_ids: tuple[str, ...] = (), *, frame_id: str = "u1"
) -> None:
    ws.send_json(
        {
            "type": "unsubscribe_v2",
            "id": frame_id,
            "payload": {"session_id": session_id, "agent_ids": list(agent_ids)},
        }
    )
    until_ack(ws, frame_id)


def until_ack(ws: Any, frame_id: str) -> dict[str, Any]:
    for _ in range(20):
        frame: dict[str, Any] = ws.receive_json()
        if frame["type"] == "ack" and frame["id"] == frame_id:
            return frame
    raise AssertionError(f"没等到回执 {frame_id}")


def next_change(ws: Any) -> dict[str, Any]:
    for _ in range(20):
        frame: dict[str, Any] = ws.receive_json()
        if frame["type"] == "event.fs.changed":
            return frame
    raise AssertionError("没等到文件变化")


@pytest.mark.parametrize("path", ["/v1/events", "/v1/ws"])
@pytest.mark.parametrize("headers", [{}, bearer("not-a-known-key"), {"Authorization": BFF_KEY}])
def test_an_unknown_app_is_refused_before_the_handshake(
    client: TestClient, path: str, headers: dict[str, str]
) -> None:
    with (
        pytest.raises(WebSocketDisconnect) as refused,
        client.websocket_connect(path, headers=headers),
    ):
        pass

    assert refused.value.code == 1008


def test_overflowing_the_outbound_queue_closes_the_connection(
    client: TestClient, hub: AppEventHub
) -> None:
    with client.websocket_connect("/v1/events", headers=bearer(BFF_KEY)) as ws:

        def flood() -> None:
            for index in range(MAX_OUTBOUND + 10):
                hub.publish(activity(BFF_SESSION, busy=index % 2 == 0))

        in_app_loop(client, flood)

        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_json()

    assert closed.value.code == 1013


def eventually(check: Callable[[], bool], seconds: float = 2.0) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if check():
            return True
        time.sleep(0.01)
    return check()


@pytest.mark.timeout(10)
def test_overflowing_during_catchup_closes_and_releases_the_session(
    client: TestClient,
    transcripts: FakeTranscripts,
    file_changes: RecordingFileChanges,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(streams, "MAX_OUTBOUND", 2)
    transcripts.live_during_subscribe = streams.MAX_OUTBOUND + 1

    with client.websocket_connect("/v1/ws", headers=bearer(BFF_KEY)) as ws:
        send_subscribe(ws, BFF_SESSION, {MAIN_AGENT_ID: "delta", CHILD: "delta"})
        with pytest.raises(WebSocketDisconnect) as closed:
            for _ in range(20):
                ws.receive_json()
        assert closed.value.code == 1013

        ws.close()
        released = eventually(lambda: transcripts.pins == 0 and not transcripts.listeners)
        assert released, (transcripts.pins, list(transcripts.listeners))

    assert file_changes.log == [("attach", BFF_SESSION), ("detach", BFF_SESSION)]


@pytest.mark.timeout(10)
def test_a_close_while_handling_a_frame_ends_the_connection_quietly(
    client: TestClient,
    transcripts: FakeTranscripts,
    sessions: FakeSessions,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(streams, "MAX_OUTBOUND", 2)
    transcripts.live_during_subscribe = streams.MAX_OUTBOUND + 1
    sessions.delay = 0.05

    with client.websocket_connect("/v1/ws", headers=bearer(BFF_KEY)) as ws:
        send_subscribe(ws, BFF_SESSION, {MAIN_AGENT_ID: "delta"})
        send_subscribe(ws, OTHER_BFF_SESSION, {MAIN_AGENT_ID: "delta"}, frame_id="s2")
        with pytest.raises(WebSocketDisconnect) as closed:
            for _ in range(20):
                ws.receive_json()
        assert closed.value.code == 1013

        released = eventually(lambda: transcripts.pins == 0 and not transcripts.listeners)
        assert released, (transcripts.pins, list(transcripts.listeners))


@pytest.mark.timeout(10)
def test_catchup_that_does_not_fit_falls_back_to_a_reset(
    client: TestClient, transcripts: FakeTranscripts, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(streams, "MAX_OUTBOUND", 4)
    transcripts.catchup = {MAIN_AGENT_ID: streams.MAX_OUTBOUND}

    with client.websocket_connect("/v1/ws", headers=bearer(BFF_KEY)) as ws:
        send_subscribe(ws, BFF_SESSION, {MAIN_AGENT_ID: "delta"}, since={MAIN_AGENT_ID: 7})
        reset, ack = ws.receive_json(), ws.receive_json()
        unsubscribe(ws, BFF_SESSION)

    assert (reset["type"], reset["payload"]["agent_id"]) == ("transcript.reset", MAIN_AGENT_ID)
    assert (ack["type"], ack["id"], ack["payload"]["accepted"]) == ("ack", "s1", [BFF_SESSION])


@pytest.mark.timeout(10)
def test_catchup_leaves_room_for_the_agents_after_it_in_the_same_frame(
    client: TestClient, transcripts: FakeTranscripts, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(streams, "MAX_OUTBOUND", 8)
    transcripts.catchup = {MAIN_AGENT_ID: 4, CHILD: 3, OTHER_CHILD: 2}
    agents = (MAIN_AGENT_ID, CHILD, OTHER_CHILD)

    with client.websocket_connect("/v1/ws", headers=bearer(BFF_KEY)) as ws:
        send_subscribe(
            ws,
            BFF_SESSION,
            dict.fromkeys(agents, "delta"),
            since=dict.fromkeys(agents, 7),
        )
        received: list[tuple[str, str]] = []
        frame: dict[str, Any] = {}
        for _ in range(20):
            frame = ws.receive_json()
            if frame["type"] == "ack":
                break
            received.append((frame["payload"]["agent_id"], frame["type"]))
        unsubscribe(ws, BFF_SESSION)

    assert received == [
        *[(MAIN_AGENT_ID, "transcript.ops")] * 4,
        (CHILD, "transcript.reset"),
        *[(OTHER_CHILD, "transcript.ops")] * 2,
    ]
    ack = frame
    assert (ack["type"], ack["id"], ack["payload"]["accepted"]) == ("ack", "s1", [BFF_SESSION])


def test_several_agents_register_once_and_the_last_one_out_unregisters(
    client: TestClient, file_changes: RecordingFileChanges
) -> None:
    with client.websocket_connect("/v1/ws", headers=bearer(BFF_KEY)) as ws:
        subscribe(ws, BFF_SESSION, {MAIN_AGENT_ID: "delta", CHILD: "turn"})
        subscribe(ws, BFF_SESSION, {MAIN_AGENT_ID: "turn", CHILD: "off"}, frame_id="s2")
        unsubscribe(ws, BFF_SESSION, (CHILD,))
        assert file_changes.log == [("attach", BFF_SESSION)]

        in_app_loop(client, lambda: file_changes.publish(wrote(BFF_SESSION, "still.md")))
        still = next_change(ws)

        unsubscribe(ws, BFF_SESSION, (MAIN_AGENT_ID,), frame_id="u2")
        assert file_changes.log == [("attach", BFF_SESSION), ("detach", BFF_SESSION)]

        subscribe(ws, OTHER_BFF_SESSION, {MAIN_AGENT_ID: "off"}, frame_id="s3")

        def publish() -> None:
            file_changes.publish(wrote(BFF_SESSION, "gone.md"))
            file_changes.publish(wrote(OTHER_BFF_SESSION, "sentinel.md"))

        in_app_loop(client, publish)
        after = next_change(ws)

    assert still["payload"]["changes"][0]["path"] == "still.md"
    assert (after["session_id"], after["payload"]["changes"][0]["path"]) == (
        OTHER_BFF_SESSION,
        "sentinel.md",
    )
