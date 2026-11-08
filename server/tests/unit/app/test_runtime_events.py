from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator, Iterator
from contextlib import asynccontextmanager
from typing import Any, Self, cast

from structlog.testing import capture_logs

from iclip.app.runtime_events import RuntimeEvents
from iclip.domains.agents.transcript_api import LiveConnections
from iclip.platform.runtime_api.client import (
    EventStream,
    RuntimeClient,
    RuntimeUnavailable,
    StreamClosed,
)


class _Dropping:
    def __aiter__(self) -> Self:
        return self

    async def __anext__(self) -> Any:
        raise StreamClosed(1012, "测试里断开")


Step = RuntimeUnavailable | _Dropping


class _ScriptedClient(RuntimeClient):
    def __init__(self, steps: list[Step]) -> None:
        super().__init__("http://runtime.test", "test-key")
        self._steps: Iterator[Step] = iter(steps)
        self.exhausted = asyncio.Event()

    @asynccontextmanager
    async def connect_events(self) -> AsyncGenerator[EventStream]:
        step = next(self._steps, None)
        if step is None:
            self.exhausted.set()
            await asyncio.Event().wait()
        if isinstance(step, RuntimeUnavailable):
            raise step
        yield cast(EventStream, step)


async def _logs_of(
    steps: list[Step],
    *,
    retry_seconds: float = 0.01,
    startup_grace_seconds: float = 60.0,
) -> list[tuple[str, str]]:
    async with _ScriptedClient(steps) as client:
        events = RuntimeEvents(
            client,
            LiveConnections(),
            first_retry_seconds=retry_seconds,
            max_retry_seconds=retry_seconds,
            startup_grace_seconds=startup_grace_seconds,
        )
        with capture_logs() as logs:
            events.start()
            try:
                await asyncio.wait_for(client.exhausted.wait(), 5)
            finally:
                await events.stop()
    for entry in logs:
        if entry["log_level"] == "warning":
            assert entry["reason"]
            assert entry["retry_seconds"] > 0
    return [(entry["log_level"], entry["event"]) for entry in logs]


def _refused() -> RuntimeUnavailable:
    return RuntimeUnavailable("连不上运行时服务")


async def test_startup_failures_log_one_info_until_connected() -> None:
    logs = await _logs_of([_refused(), _refused(), _refused(), _Dropping()])

    assert logs == [
        ("info", "运行时还没起来，起来后自动连上事件流"),
        ("info", "运行时事件流已连上"),
        ("warning", "运行时事件流断了，关掉全部订阅连接后重连"),
    ]


async def test_failures_past_the_startup_grace_are_warnings() -> None:
    logs = await _logs_of(
        [_refused(), _refused(), _refused()], retry_seconds=0.1, startup_grace_seconds=0.05
    )

    never = ("warning", "运行时事件流自启动起一直连不上，关掉全部订阅连接后重连")
    assert logs == [("info", "运行时还没起来，起来后自动连上事件流"), never, never]


async def test_failures_after_a_connection_are_warnings() -> None:
    logs = await _logs_of([_Dropping(), _refused()])

    dropped = ("warning", "运行时事件流断了，关掉全部订阅连接后重连")
    assert logs == [("info", "运行时事件流已连上"), dropped, dropped]
