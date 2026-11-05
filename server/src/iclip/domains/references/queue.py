from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass
from typing import Final

import procrastinate
import structlog

from iclip.domains.references.models import BREAKDOWN_TIMEOUT_SECONDS, BreakdownFailed
from iclip.domains.references.repository import ReferenceStore, VideoBreakdowns
from iclip.domains.tagging.public import KIND_REFERENCE, EntryKey, TaggingService

_logger = structlog.stdlib.get_logger(__name__)

QUEUE: Final = "references"

_STOP_MARGIN_SECONDS: Final = 5


@dataclass(frozen=True, slots=True)
class ReferenceQueueSettings:
    concurrency: int = 2

    shutdown_grace_seconds: int = 15

    heartbeat_interval_seconds: int = 10
    stalled_worker_timeout_seconds: int = 30


class ReferenceQueue:
    def __init__(
        self,
        store: ReferenceStore,
        *,
        breakdowns: VideoBreakdowns,
        tagging: TaggingService,
        connector: procrastinate.BaseConnector,
        settings: ReferenceQueueSettings | None = None,
    ) -> None:
        self._store = store
        self._breakdowns = breakdowns
        self._tagging = tagging
        self._settings = settings or ReferenceQueueSettings()
        self._app = procrastinate.App(connector=connector)
        self._worker: asyncio.Task[None] | None = None

        self._run = self._app.task(name="references.run_breakdown", queue=QUEUE)(self.run_breakdown)
        heal = self._app.task(name="references.time_out_stalled", queue=QUEUE, pass_context=True)(
            self._heal_periodic
        )
        self._app.periodic(cron="* * * * *", periodic_id="references-time-out")(heal)

    @property
    def app(self) -> procrastinate.App:
        return self._app

    async def enqueue_breakdown(self, reference_id: uuid.UUID) -> None:
        await self._run.defer_async(reference_id=str(reference_id))

    async def run_breakdown(self, reference_id: str) -> None:
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
        if not await self._store.finish(claim, document=document):
            _logger.info("参考视频在写回之前已被收尾，这次的结果不写", reference_id=claim.id)
            return
        await self._tagging.enqueue(
            EntryKey(kind=KIND_REFERENCE, subject_id=claim.id), created_by=claim.owner_user_id
        )

    async def time_out_stalled(self) -> int:
        count = await self._store.time_out_stalled(older_than_seconds=BREAKDOWN_TIMEOUT_SECONDS)
        if count:
            _logger.warning("参考视频拆解超时，已按超时收尾", count=count)
        return count

    async def _heal_periodic(self, context: procrastinate.JobContext, timestamp: int) -> None:
        await self.time_out_stalled()

    def start(self) -> None:
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
                install_signal_handlers=False,
                delete_jobs="successful",
            ),
            name="references-worker",
        )

    async def stop(self) -> None:
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
