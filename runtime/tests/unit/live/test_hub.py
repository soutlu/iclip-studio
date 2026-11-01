"""验证应用事件的发布顺序、预览会话的标记与归属查询失败隔离。"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator, Mapping
from dataclasses import dataclass

import pytest

from agent_runtime.live.frames import (
    AppEvent,
    FsChanged,
    SessionWorkChanged,
)
from agent_runtime.live.hub import AppEventHub, RouteOf
from agent_runtime.transcript.wire import SessionActivityOut

BFF_SESSION = "0b8e9f4c-6a1d-4f2e-9c3b-5d7a1e2f3c4d"
OTHER_BFF_SESSION = "9d2c1b0a-5e4f-4a3b-8c7d-6e5f4a3b2c1d"
TOOL_SESSION = "1a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d"
PREVIEW_SESSION = "3e9a7c51-8b2d-4f6e-a1c0-7d5b3f9e2a84"
OWNER = "6f1d8a4e-2b7c-4e0a-9d51-3c2f7e8b9a10"
AT = "2026-10-30T08:00:00+00:00"


@dataclass(frozen=True)
class Route:
    app_id: str
    preview: bool = False


APPS = {
    BFF_SESSION: Route("bff"),
    OTHER_BFF_SESSION: Route("bff"),
    TOOL_SESSION: Route("tool"),
    PREVIEW_SESSION: Route("bff", preview=True),
}


class Sink:
    def __init__(self) -> None:
        self.frames: list[AppEvent | FsChanged] = []

    def offer(self, frame: AppEvent | FsChanged) -> None:
        self.frames.append(frame)


def lookup(apps: Mapping[str, Route], delays: Mapping[str, int]) -> RouteOf:
    """按表查归属；``delays`` 给某段会话让查询多让出几次事件循环，模拟读库有快有慢。"""

    async def route_of(session_id: str) -> Route | None:
        for _ in range(delays.get(session_id, 0)):
            await asyncio.sleep(0)
        return apps.get(session_id)

    return route_of


def busy(session_id: str, *, busy: bool) -> SessionWorkChanged:
    return SessionWorkChanged(
        session_id=session_id,
        owner_user_id=OWNER,
        timestamp=AT,
        payload=SessionActivityOut(busy=busy, pending_interaction="none"),
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
        if isinstance(frame, SessionWorkChanged)
    ] == [
        (BFF_SESSION, False),
        (OTHER_BFF_SESSION, True),
        (BFF_SESSION, True),
        (OTHER_BFF_SESSION, False),
    ]


async def test_events_of_unknown_sessions_are_dropped(hub: AppEventHub) -> None:
    sink = Sink()
    hub.attach("bff", sink)

    hub.publish(busy("4c3b2a19-0f8e-4d7c-b6a5-948372615041", busy=True))
    hub.publish(busy(OTHER_BFF_SESSION, busy=True))
    await drained(sink, count=1)

    assert [frame.session_id for frame in sink.frames] == [OTHER_BFF_SESSION]


async def test_only_events_of_preview_sessions_are_marked_preview(hub: AppEventHub) -> None:
    sink = Sink()
    hub.attach("bff", sink)

    hub.publish(busy(PREVIEW_SESSION, busy=True))
    hub.publish(busy(OTHER_BFF_SESSION, busy=True))
    await drained(sink, count=2)

    assert [
        (frame.session_id, frame.preview)
        for frame in sink.frames
        if isinstance(frame, SessionWorkChanged)
    ] == [(PREVIEW_SESSION, True), (OTHER_BFF_SESSION, False)]


async def test_a_failing_lookup_drops_only_that_event() -> None:
    async def flaky(session_id: str) -> Route | None:
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

    async def route_of(session_id: str) -> Route | None:
        looked_up.append(session_id)
        return Route("bff")

    hub = AppEventHub(route_of)
    await hub.start()
    try:
        hub.publish(busy(BFF_SESSION, busy=True))
        for _ in range(5):
            await asyncio.sleep(0)
    finally:
        await hub.stop()

    assert looked_up == []
