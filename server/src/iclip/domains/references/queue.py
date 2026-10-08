"""参考视频的后台拆解。自带一个 procrastinate App，队列 ``references``，与生成队列共用组合根的连接器。

一次任务：接手（``pending`` → ``running``）→ 拆解 → 打标 → 一次写回。拆解任务**不挂自动重试**：
崩在半路自动重投会再付一次钱。崩在半路的行停在拆解中，由每分钟一次的周期任务按超时收尾；重拆由
人或 AI 导演决定。"""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass
from typing import Final

import procrastinate
import structlog

from iclip.domains.references.models import (
    BREAKDOWN_TIMEOUT_SECONDS,
    BreakdownFailed,
    TaggingFailed,
    Tags,
)
from iclip.domains.references.repository import ReferenceStore, Tagger, VideoBreakdowns

_logger = structlog.stdlib.get_logger(__name__)

QUEUE: Final = "references"

_STOP_MARGIN_SECONDS: Final = 5
"""worker 自身关停宽限期之外的等待余量。"""


@dataclass(frozen=True, slots=True)
class ReferenceQueueSettings:
    concurrency: int = 2
    """每个服务进程同时拆几条。拆解在本机跑 ffmpeg，单个请求几十 MB。"""

    shutdown_grace_seconds: int = 15
    """关停时等执行中任务的时限；没等完的那一行停在拆解中，按超时收尾。"""

    heartbeat_interval_seconds: int = 10
    stalled_worker_timeout_seconds: int = 30


class ReferenceQueue:
    """排拆解、执行拆解、收尾超时；任务协程可独立于调度器调用。"""

    def __init__(
        self,
        store: ReferenceStore,
        *,
        breakdowns: VideoBreakdowns,
        tagger: Tagger,
        connector: procrastinate.BaseConnector,
        settings: ReferenceQueueSettings | None = None,
    ) -> None:
        self._store = store
        self._breakdowns = breakdowns
        self._tagger = tagger
        self._settings = settings or ReferenceQueueSettings()
        self._app = procrastinate.App(connector=connector)
        self._worker: asyncio.Task[None] | None = None

        # 不给 retry：任务抛出就停在 failed，不重投。
        self._run = self._app.task(name="references.run_breakdown", queue=QUEUE)(self.run_breakdown)
        heal = self._app.task(name="references.time_out_stalled", queue=QUEUE, pass_context=True)(
            self._heal_periodic
        )
        self._app.periodic(cron="* * * * *", periodic_id="references-time-out")(heal)

    @property
    def app(self) -> procrastinate.App:
        return self._app

    async def enqueue_breakdown(self, reference_id: uuid.UUID) -> None:
        """排一次拆解；排不上就抛出，由服务层收尾这一行。"""

        await self._run.defer_async(reference_id=str(reference_id))

    async def run_breakdown(self, reference_id: str) -> None:
        """拆一次：接手不到（已被别的执行接手或已有结论）就不做。"""

        claim = await self._store.claim(uuid.UUID(reference_id))
        if claim is None:
            _logger.info("参考视频不在排队中，不再拆", reference_id=reference_id)
            return
        try:
            document = await self._breakdowns.breakdown(claim.video_url)
        except BreakdownFailed as exc:
            written = await self._store.fail(claim, error_code=exc.code)
            _logger.warning(
                "参考视频拆解失败",
                reference_id=claim.id,
                code=exc.code,
                error=str(exc),
                written=written,
            )
            return
        tags = await self._tag(claim.id, document)
        if not await self._store.finish(claim, document=document, tags=tags):
            _logger.info("参考视频在写回之前已被收尾，这次的结果不写", reference_id=claim.id)

    async def _tag(self, reference_id: uuid.UUID, document: str) -> Tags:
        """打标失败不算拆解失败：拆解照常保存，标签留空。"""

        try:
            return await self._tagger.tag(document)
        except TaggingFailed as exc:
            _logger.warning("参考视频打标失败，标签留空", reference_id=reference_id, error=str(exc))
            return Tags()

    async def time_out_stalled(self) -> int:
        """拆解中超过 ``BREAKDOWN_TIMEOUT_SECONDS`` 的行收成 ``failed / timeout``，交回几行。"""

        count = await self._store.time_out_stalled(older_than_seconds=BREAKDOWN_TIMEOUT_SECONDS)
        if count:
            _logger.warning("参考视频拆解超时，已按超时收尾", count=count)
        return count

    async def _heal_periodic(self, context: procrastinate.JobContext, timestamp: int) -> None:
        await self.time_out_stalled()

    def start(self) -> None:
        """幂等启动 worker。"""

        if self._worker is not None:
            return
        settings = self._settings
        self._worker = asyncio.create_task(
            self._app.run_worker_async(
                queues=[QUEUE],
                name=QUEUE,
                concurrency=settings.concurrency,
                shutdown_graceful_timeout=settings.shutdown_grace_seconds,
                update_heartbeat_interval=settings.heartbeat_interval_seconds,
                stalled_worker_timeout=settings.stalled_worker_timeout_seconds,
                # 信号处理统一交给 uvicorn，避免覆盖 SIGTERM 处理器。
                install_signal_handlers=False,
                delete_jobs="successful",
            ),
            name="references-worker",
        )

    async def stop(self) -> None:
        """取消 worker 并在宽限期内等它退出。"""

        if self._worker is None:
            return
        worker, self._worker = self._worker, None
        worker.cancel()
        _, pending = await asyncio.wait(
            {worker}, timeout=self._settings.shutdown_grace_seconds + _STOP_MARGIN_SECONDS
        )
        if pending:
            _logger.warning("参考视频 worker 没在关停宽限期内收干净，不再等它")


__all__ = ["QUEUE", "ReferenceQueue", "ReferenceQueueSettings"]
