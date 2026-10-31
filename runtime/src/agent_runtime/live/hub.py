"""两条实时通道的分发：会话活动按应用发到应用事件流，工作区文件变化按会话发到订着它的对话内容流连接。

会话活动在写入提交之后由 ``AppEventHub.publish`` 同步收下（不 await），按收下的先后排进一条队列；一个分发任务
依次按会话找到它归哪个应用，再交给这个应用的每条连接。查归属可能要读库，整条路只有这一个消费者，所以每条
连接上事件的先后与收下的先后一致。

文件变化由 ``SessionFileChanges.publish`` 同步交给登记了这段会话的连接，不查归属：连接订阅时已经核过会话归
它的应用。

两者都是易失通知：此刻没有连接时直接丢掉，查不到归属的活动也丢掉。
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Awaitable, Callable
from typing import Protocol

import structlog

from agent_runtime.live.frames import AppEvent, FsChanged

_logger = structlog.stdlib.get_logger(__name__)

AppOf = Callable[[str], Awaitable[str | None]]
"""按会话 id 查它归哪个应用；没有这个会话给 ``None``。"""


class EventSink(Protocol):
    """一条事件流连接：``offer`` 同步收下一帧，自己管积压。"""

    def offer(self, frame: AppEvent) -> None: ...


class FileChangeSink(Protocol):
    """一条对话内容流连接：``offer`` 同步收下一帧，自己管积压。"""

    def offer(self, frame: FsChanged) -> None: ...


class AppEventHub:
    """各应用的事件流连接与按序分发事件的那个任务；任务随服务的 lifespan 起停。"""

    def __init__(self, app_of: AppOf) -> None:
        self._app_of = app_of
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
        """收下一个事件；在写入提交之后同步调用，这一步之后到达的事件排在它后面。"""

        if not self._sinks:
            return
        self._pending.put_nowait(event)

    async def start(self) -> None:
        self._dispatcher = asyncio.create_task(self._dispatch())

    async def stop(self) -> None:
        """停掉分发；还没分发的事件丢掉。"""

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
                app_id = await self._app_of(event.session_id)
            except Exception:
                _logger.exception("查不到会话归哪个应用，这条事件不发", session_id=event.session_id)
                continue
            if app_id is None:
                continue
            # 连接可能在 offer 里因积压溢出被摘掉，遍历副本。
            for sink in tuple(self._sinks.get(app_id, ())):
                sink.offer(event)


class SessionFileChanges:
    """按会话登记的对话内容流连接；工作区文件变化交给登记了那段会话的每条连接。

    一条连接为一段会话只登记一次：第一次为它加监听时登记，最后一个监听撤掉时注销。
    """

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
        """在写入提交之后同步调用，不 await；此刻没有连接登记这段会话就丢掉。"""

        for sink in self._sinks.get(frame.session_id, ()):
            sink.offer(frame)


__all__ = ["AppEventHub", "AppOf", "EventSink", "FileChangeSink", "SessionFileChanges"]
