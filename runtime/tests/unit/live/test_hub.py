"""两条通道的分发：应用事件集线器让每个应用的每条连接收到这个应用所有会话的活动、别的应用的收不到，查归属
要等的时候也按收下的先后送达，没有连接或查不到归属的丢掉；文件变化按会话发给登记了它的连接。帧按约定的形状
序列化。"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncGenerator, Mapping

import pytest

from agent_runtime.live.frames import (
    AppEvent,
    FsChanged,
    FsChangeEntry,
    FsChangesPayload,
    Ping,
    PingPayload,
    SessionActivity,
    TranscriptOpsFrame,
    TranscriptResetFrame,
)
from agent_runtime.live.hub import AppEventHub, AppOf, SessionFileChanges
from agent_runtime.transcript.ops import ItemsRemoveOp, TranscriptSnapshot
from agent_runtime.transcript.wire import OpsPayload, ResetPayload, SessionActivityOut

BFF_SESSION = "0b8e9f4c-6a1d-4f2e-9c3b-5d7a1e2f3c4d"
OTHER_BFF_SESSION = "9d2c1b0a-5e4f-4a3b-8c7d-6e5f4a3b2c1d"
TOOL_SESSION = "1a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d"
OWNER = "6f1d8a4e-2b7c-4e0a-9d51-3c2f7e8b9a10"
AT = "2026-10-30T08:00:00+00:00"

APPS = {BFF_SESSION: "bff", OTHER_BFF_SESSION: "bff", TOOL_SESSION: "tool"}


class Sink:
    def __init__(self) -> None:
        self.frames: list[AppEvent | FsChanged] = []

    def offer(self, frame: AppEvent | FsChanged) -> None:
        self.frames.append(frame)


def lookup(apps: Mapping[str, str], delays: Mapping[str, int]) -> AppOf:
    """按表查归属；``delays`` 给某段会话让查询多让出几次事件循环，模拟读库有快有慢。"""

    async def app_of(session_id: str) -> str | None:
        for _ in range(delays.get(session_id, 0)):
            await asyncio.sleep(0)
        return apps.get(session_id)

    return app_of


def busy(session_id: str, *, busy: bool) -> SessionActivity:
    return SessionActivity(
        session_id=session_id,
        owner_user_id=OWNER,
        timestamp=AT,
        payload=SessionActivityOut(busy=busy, pending_interaction="none"),
    )


def wrote(session_id: str, path: str) -> FsChanged:
    return FsChanged(
        session_id=session_id,
        timestamp=AT,
        payload=FsChangesPayload(changes=(FsChangeEntry(path=path, change="created"),)),
    )


@pytest.fixture
async def hub() -> AsyncGenerator[AppEventHub]:
    hub = AppEventHub(lookup(APPS, delays={BFF_SESSION: 5}))
    await hub.start()
    try:
        yield hub
    finally:
        await hub.stop()


async def drained(*sinks: Sink, count: int, tries: int = 100) -> None:
    for _ in range(tries):
        if sum(len(sink.frames) for sink in sinks) >= count:
            return
        await asyncio.sleep(0)
    raise AssertionError("事件没送到")


# --- 应用事件集线器 -------------------------------------------------------------


async def test_every_connection_of_an_app_gets_its_events_and_no_other_apps(
    hub: AppEventHub,
) -> None:
    first, second, tool = Sink(), Sink(), Sink()
    hub.attach("bff", first)
    hub.attach("bff", second)
    hub.attach("tool", tool)

    hub.publish(busy(BFF_SESSION, busy=True))
    hub.publish(busy(TOOL_SESSION, busy=True))
    hub.publish(busy(OTHER_BFF_SESSION, busy=False))
    await drained(first, second, tool, count=5)

    sessions = [frame.session_id for frame in first.frames]
    assert sessions == [BFF_SESSION, OTHER_BFF_SESSION]
    assert second.frames == first.frames
    assert [frame.session_id for frame in tool.frames] == [TOOL_SESSION]


async def test_events_arrive_in_publish_order_even_when_a_lookup_is_slow(
    hub: AppEventHub,
) -> None:
    """busy 的那段查归属慢；随后的 idle 不能抢在它前面。"""

    sink = Sink()
    hub.attach("bff", sink)

    hub.publish(busy(BFF_SESSION, busy=False))
    hub.publish(busy(OTHER_BFF_SESSION, busy=True))
    hub.publish(busy(BFF_SESSION, busy=True))
    hub.publish(busy(OTHER_BFF_SESSION, busy=False))
    await drained(sink, count=4)

    assert [
        (frame.session_id, frame.payload.busy)
        for frame in sink.frames
        if isinstance(frame, SessionActivity)
    ] == [
        (BFF_SESSION, False),
        (OTHER_BFF_SESSION, True),
        (BFF_SESSION, True),
        (OTHER_BFF_SESSION, False),
    ]


async def test_a_detached_connection_gets_nothing_more(hub: AppEventHub) -> None:
    gone, staying = Sink(), Sink()
    hub.attach("bff", gone)
    hub.attach("bff", staying)
    hub.detach("bff", gone)

    hub.publish(busy(OTHER_BFF_SESSION, busy=True))
    await drained(staying, count=1)

    assert gone.frames == []


async def test_events_of_unknown_sessions_are_dropped(hub: AppEventHub) -> None:
    sink = Sink()
    hub.attach("bff", sink)

    hub.publish(busy("4c3b2a19-0f8e-4d7c-b6a5-948372615041", busy=True))
    hub.publish(busy(OTHER_BFF_SESSION, busy=True))
    await drained(sink, count=1)

    assert [frame.session_id for frame in sink.frames] == [OTHER_BFF_SESSION]


async def test_a_failing_lookup_drops_only_that_event() -> None:
    async def flaky(session_id: str) -> str | None:
        if session_id == BFF_SESSION:
            raise ConnectionError("库连不上")
        return APPS.get(session_id)

    hub = AppEventHub(flaky)
    await hub.start()
    sink = Sink()
    hub.attach("bff", sink)
    try:
        hub.publish(busy(BFF_SESSION, busy=True))
        hub.publish(busy(OTHER_BFF_SESSION, busy=True))
        await drained(sink, count=1)
    finally:
        await hub.stop()

    assert [frame.session_id for frame in sink.frames] == [OTHER_BFF_SESSION]


async def test_without_connections_events_are_not_queued() -> None:
    looked_up: list[str] = []

    async def app_of(session_id: str) -> str | None:
        looked_up.append(session_id)
        return "bff"

    hub = AppEventHub(app_of)
    await hub.start()
    try:
        hub.publish(busy(BFF_SESSION, busy=True))
        for _ in range(5):
            await asyncio.sleep(0)
    finally:
        await hub.stop()

    assert looked_up == []


# --- 文件变化 -------------------------------------------------------------------


def test_a_file_change_goes_to_every_connection_registered_for_its_session() -> None:
    changes = SessionFileChanges()
    first, second, elsewhere = Sink(), Sink(), Sink()
    changes.attach(BFF_SESSION, first)
    changes.attach(BFF_SESSION, second)
    changes.attach(OTHER_BFF_SESSION, elsewhere)

    changes.publish(wrote(BFF_SESSION, "notes.md"))

    # 同步送到，不等事件循环。
    assert first.frames == [wrote(BFF_SESSION, "notes.md")]
    assert second.frames == first.frames
    assert elsewhere.frames == []


def test_a_detached_connection_gets_no_more_file_changes() -> None:
    changes = SessionFileChanges()
    gone, staying = Sink(), Sink()
    changes.attach(BFF_SESSION, gone)
    changes.attach(BFF_SESSION, staying)
    changes.detach(BFF_SESSION, gone)
    # 没登记过的注销什么都不做。
    changes.detach(TOOL_SESSION, gone)

    changes.publish(wrote(BFF_SESSION, "notes.md"))
    changes.publish(wrote(TOOL_SESSION, "notes.md"))

    assert gone.frames == []
    assert [frame.session_id for frame in staying.frames] == [BFF_SESSION]


# --- 帧的形状 -------------------------------------------------------------------


def test_frames_serialize_to_the_documented_shape() -> None:
    activity = json.loads(busy(BFF_SESSION, busy=False).model_dump_json(exclude_none=True))
    assert activity == {
        "type": "event.session.work_changed",
        "session_id": BFF_SESSION,
        "owner_user_id": OWNER,
        "timestamp": AT,
        "payload": {"busy": False, "pending_interaction": "none"},
    }

    changed = json.loads(wrote(TOOL_SESSION, "a/b.md").model_dump_json(exclude_none=True))
    assert changed == {
        "type": "event.fs.changed",
        "session_id": TOOL_SESSION,
        "timestamp": AT,
        "payload": {"changes": [{"path": "a/b.md", "change": "created"}]},
    }

    ops = TranscriptOpsFrame(
        session_id=BFF_SESSION,
        timestamp=AT,
        stream_epoch="epoch-1",
        payload=OpsPayload(agent_id="main", ops=(ItemsRemoveOp(ids=("t1",)),), seq=3),
    )
    sent = json.loads(ops.model_dump_json(exclude_none=True, by_alias=True))
    # 信封上只有会话、时刻与实时流，没有会话事件的 epoch / seq；载荷带与外层相同的 type。
    assert sent == {
        "type": "transcript.ops",
        "session_id": BFF_SESSION,
        "timestamp": AT,
        "stream_epoch": "epoch-1",
        "payload": {
            "type": "transcript.ops",
            "agent_id": "main",
            "ops": [{"op": "items.remove", "ids": ["t1"]}],
            "seq": 3,
        },
    }

    reset = TranscriptResetFrame(
        session_id=BFF_SESSION,
        timestamp=AT,
        stream_epoch="epoch-1",
        payload=ResetPayload(agent_id="main", snapshot=TranscriptSnapshot(), seq=0),
    )
    sent_reset = json.loads(reset.model_dump_json(exclude_none=True, by_alias=True))
    assert (sent_reset["timestamp"], sent_reset["payload"]["type"]) == (AT, "transcript.reset")

    ping = json.loads(Ping(timestamp=AT, payload=PingPayload(nonce="n1")).model_dump_json())
    assert ping == {"type": "ping", "timestamp": AT, "payload": {"nonce": "n1"}}
