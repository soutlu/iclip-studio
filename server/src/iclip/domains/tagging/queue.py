from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass
from typing import Final

import procrastinate
import structlog

from iclip.domains.tagging.models import (
    AUTO_FILL_AI,
    ERROR_NO_SOURCE_TEXT,
    TAGGING_TIMEOUT_SECONDS,
    TaggingFailed,
)
from iclip.domains.tagging.repository import SourceText, Tagger, TagStore

_logger = structlog.stdlib.get_logger(__name__)

QUEUE: Final = "tagging"

_STOP_MARGIN_SECONDS: Final = 5


@dataclass(frozen=True, slots=True)
class TaggingQueueSettings:
    concurrency: int = 4

    shutdown_grace_seconds: int = 15
    heartbeat_interval_seconds: int = 10
    stalled_worker_timeout_seconds: int = 30


class TaggingQueue:
    def __init__(
        self,
        store: TagStore,
        *,
        source_text: SourceText,
        tagger: Tagger,
        connector: procrastinate.BaseConnector,
        settings: TaggingQueueSettings | None = None,
    ) -> None:
        self._store = store
        self._source_text = source_text
        self._tagger = tagger
        self._settings = settings or TaggingQueueSettings()
        self._app = procrastinate.App(connector=connector)
        self._worker: asyncio.Task[None] | None = None

        self._run = self._app.task(name="tagging.run_tagging", queue=QUEUE)(self.run_tagging)
        heal = self._app.task(name="tagging.time_out_stalled", queue=QUEUE, pass_context=True)(
            self._heal_periodic
        )
        self._app.periodic(cron="* * * * *", periodic_id="tagging-time-out")(heal)

    @property
    def app(self) -> procrastinate.App:
        return self._app

    async def enqueue_tagging(self, entry_id: uuid.UUID) -> None:
        await self._run.defer_async(entry_id=str(entry_id))

    async def run_tagging(self, entry_id: str) -> None:
        claim = await self._store.claim(uuid.UUID(entry_id))
        if claim is None:
            _logger.info("条目不在排队中，不再打标", entry_id=entry_id)
            return
        text = await self._source_text.text(claim.key)
        if text is None:
            written = await self._store.fail(claim, error_code=ERROR_NO_SOURCE_TEXT)
            _logger.warning("取不到打标用的文字", entry_id=claim.entry_id, written=written)
            return
        dimensions = [one for one in await self._store.tree() if one.auto_fill == AUTO_FILL_AI]
        try:
            tag_ids = await self._tagger.tag(text, dimensions) if dimensions else ()
        except TaggingFailed as exc:
            written = await self._store.fail(claim, error_code=exc.code)
            _logger.warning(
                "打标失败", entry_id=claim.entry_id, code=exc.code, error=str(exc), written=written
            )
            return
        if not await self._store.finish(claim, tag_ids):
            _logger.info("条目在写回之前已被收尾，这次的结果不写", entry_id=claim.entry_id)

    async def time_out_stalled(self) -> int:
        count = await self._store.time_out_stalled(older_than_seconds=TAGGING_TIMEOUT_SECONDS)
        if count:
            _logger.warning("打标超时，已按超时收尾", count=count)
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
            name="tagging-worker",
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
            _logger.warning("打标 worker 没在关停宽限期内收干净，不再等它")


__all__ = ["QUEUE", "TaggingQueue", "TaggingQueueSettings"]
