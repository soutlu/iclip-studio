"""运行时应用事件流的消费者：每个后端进程一条 ``/v1/events``，把会话活动转成浏览器的全局帧。浏览器收到的
就是运行时发来的 ``event.session.work_changed`` 原文（运行时新加的字段一并到达），后端只按解析出的属主决定
发给谁；认不出类型的帧不知道该发给谁，记日志后跳过。

事件按到达的先后在这一个任务里逐个投递，所以同一段对话的帧在每条浏览器连接上仍按运行时发出的先后到达。
事件流断了（运行时重启、网络中断、还没起来）先记日志，再以 1001 关掉此刻全部浏览器连接，然后按封顶的退避
重连；每次连上时也以 1001 关掉此刻全部浏览器连接。断线期间的事件不补发，客户端重连后重订、重拉列表对齐。
浏览器的重连退避与这里的不同，可能在断线期间就已重连、重拉过，之后到事件流连上为止的活动它收不到，所以连上
时再关一次。

部署与 ``make dev`` 都是后端健康了才起运行时（它启动时要向后端核对插件服务），后端的第一次连接因此总是失败，
也走这条重连路，但日志从轻：从没连上过时只在第一次失败记一条 info；自启动起超过宽限时长仍没连上，之后每次失败记 warning。
连上过再断，每次失败都记 warning。
"""

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
"""重连的等待从 ``FIRST_RETRY_SECONDS`` 起每次翻倍，最多等这么久；连上一次就从头算。"""
STARTUP_GRACE_SECONDS: Final = 60.0
"""自启动起这么久内从没连上过，按运行时还在起来处理，重连失败不记 warning。"""


class RuntimeEvents:
    """事件流的消费任务；``start`` / ``stop`` 随后端的 lifespan 起停。"""

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
        """停掉消费任务，等它退出事件流的连接。"""

        if self._task is None:
            return
        self._task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self._task
        self._task = None

    async def wait_connected(self) -> None:
        """等事件流连上；连上时关浏览器连接在它返回之前，测试在它之后开的连接不会被这一次关掉，也不会漏掉
        活动。"""

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
                    # 关连接与置位之间没有 await：等 wait_connected 的一方之后开的连接不会被关。
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
                # 处理某一帧出了错：不让消费任务就此停掉、之后的活动全都发不出去，按断线处理重连。
                self._connected.clear()
                _logger.exception("处理运行时事件出错，关掉全部订阅连接后重连", retry_seconds=wait)
            # 连上过又断的、一次都没连上的，一样关：浏览器重连后经 HTTP 重拉，补上断线期间的变化。
            self._live.close_all(GOING_AWAY)
            await asyncio.sleep(wait)
            wait = min(wait * 2, self._max_retry)


__all__ = ["FIRST_RETRY_SECONDS", "MAX_RETRY_SECONDS", "STARTUP_GRACE_SECONDS", "RuntimeEvents"]
