from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Awaitable, Callable
from typing import Protocol

import structlog

from agent_runtime.live.frames import AppEvent, FsChanged

_logger = structlog.stdlib.get_logger(__name__)


class SessionRoute(Protocol):
    @property
    def app_id(self) -> str: ...

    @property
    def preview(self) -> bool: ...


RouteOf = Callable[[str], Awaitable[SessionRoute | None]]


class EventSink(Protocol):
    def offer(self, frame: AppEvent) -> None: ...


class FileChangeSink(Protocol):
    def offer(self, frame: FsChanged) -> None: ...


class AppEventHub:
    def __init__(self, route_of: RouteOf) -> None:
        self._route_of = route_of
        self._sinks: dict[str, set[EventSink]] = {}
        self._pending: asyncio.Queue[AppEvent] = asyncio.Queue()
        self._dispatcher: asyncio.Task[None] | None = None

    def attach(self, app_id: str, sink: EventSink) -> None:
        self._sinks.setdefault(app_id, set()).add(sink)

    def detach(self, app_id: str, sink: EventSink) -> None:
        sinks = self._sinks.get(app_id)
        if sinks is None:
            return
        sinks.discard(sink)
        if not sinks:
            del self._sinks[app_id]

    def publish(self, event: AppEvent) -> None:
        if not self._sinks:
            return
        self._pending.put_nowait(event)

    async def start(self) -> None:
        self._dispatcher = asyncio.create_task(self._dispatch())

    async def stop(self) -> None:
        if self._dispatcher is None:
            return
        self._dispatcher.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self._dispatcher
        self._dispatcher = None

    async def _dispatch(self) -> None:
        while True:
            event = await self._pending.get()
            try:
                route = await self._route_of(event.session_id)
            except Exception:
                _logger.exception("查不到会话归哪个应用，这条事件不发", session_id=event.session_id)
                continue
            if route is None:
                continue
            if route.preview:
                event = event.model_copy(update={"preview": True})
            for sink in tuple(self._sinks.get(route.app_id, ())):
                sink.offer(event)


class SessionFileChanges:
    def __init__(self) -> None:
        self._sinks: dict[str, set[FileChangeSink]] = {}

    def attach(self, session_id: str, sink: FileChangeSink) -> None:
        self._sinks.setdefault(session_id, set()).add(sink)

    def detach(self, session_id: str, sink: FileChangeSink) -> None:
        sinks = self._sinks.get(session_id)
        if sinks is None:
            return
        sinks.discard(sink)
        if not sinks:
            del self._sinks[session_id]

    def publish(self, frame: FsChanged) -> None:
        for sink in self._sinks.get(frame.session_id, ()):
            sink.offer(frame)


__all__ = [
    "AppEventHub",
    "EventSink",
    "FileChangeSink",
    "RouteOf",
    "SessionFileChanges",
    "SessionRoute",
]
