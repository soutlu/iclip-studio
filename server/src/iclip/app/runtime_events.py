from __future__ import annotations

import asyncio
import contextlib
from typing import Final

import structlog
from agent_runtime.client import RuntimeClient, RuntimeUnavailable, WorkChangedFrame

from iclip.domains.agents.transcript_api import GOING_AWAY, LiveConnections

_logger = structlog.stdlib.get_logger(__name__)

FIRST_RETRY_SECONDS: Final = 0.5
MAX_RETRY_SECONDS: Final = 10.0
STARTUP_GRACE_SECONDS: Final = 60.0


class RuntimeEvents:
    def __init__(
        self,
        client: RuntimeClient,
        live: LiveConnections,
        *,
        first_retry_seconds: float = FIRST_RETRY_SECONDS,
        max_retry_seconds: float = MAX_RETRY_SECONDS,
        startup_grace_seconds: float = STARTUP_GRACE_SECONDS,
    ) -> None:
        self._client = client
        self._live = live
        self._first_retry = first_retry_seconds
        self._max_retry = max_retry_seconds
        self._startup_grace = startup_grace_seconds
        self._task: asyncio.Task[None] | None = None
        self._connected = asyncio.Event()

    def start(self) -> None:
        self._task = asyncio.create_task(self._consume())

    async def stop(self) -> None:
        if self._task is None:
            return
        self._task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self._task
        self._task = None

    async def wait_connected(self) -> None:
        await self._connected.wait()

    async def _consume(self) -> None:
        loop = asyncio.get_running_loop()
        started = loop.time()
        ever_connected = False
        told_not_up = False
        wait = self._first_retry
        while True:
            try:
                async with self._client.connect_events() as events:
                    self._live.close_all(GOING_AWAY)
                    self._connected.set()
                    ever_connected = True
                    wait = self._first_retry
                    _logger.info("运行时事件流已连上")
                    async for event in events:
                        if isinstance(event, WorkChangedFrame):
                            self._live.announce_activity(event)
                        else:
                            _logger.info("运行时事件流上有认不出的帧，跳过", frame_type=event.type)
            except RuntimeUnavailable as exc:
                self._connected.clear()
                if ever_connected:
                    _logger.warning(
                        "运行时事件流断了，关掉全部订阅连接后重连",
                        reason=str(exc),
                        retry_seconds=wait,
                    )
                elif loop.time() - started > self._startup_grace:
                    _logger.warning(
                        "运行时事件流自启动起一直连不上，关掉全部订阅连接后重连",
                        reason=str(exc),
                        retry_seconds=wait,
                    )
                elif not told_not_up:
                    told_not_up = True
                    _logger.info("运行时还没起来，起来后自动连上事件流")
            except Exception:
                self._connected.clear()
                _logger.exception("处理运行时事件出错，关掉全部订阅连接后重连", retry_seconds=wait)
            self._live.close_all(GOING_AWAY)
            await asyncio.sleep(wait)
            wait = min(wait * 2, self._max_retry)


__all__ = ["FIRST_RETRY_SECONDS", "MAX_RETRY_SECONDS", "STARTUP_GRACE_SECONDS", "RuntimeEvents"]
