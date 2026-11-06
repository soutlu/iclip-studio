from __future__ import annotations

import asyncio
import uuid
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Final

import procrastinate
import structlog
from procrastinate import RetryDecision
from procrastinate.jobs import Job as QueuedJob

from iclip.domains.generation.models import (
    STATUS_PENDING,
    STATUS_SUBMITTED,
    STATUS_SUBMITTING,
    GenerationJob,
    GenerationOutput,
    GenerationStatus,
)
from iclip.domains.generation.provider import GenerationProvider, ProviderError
from iclip.domains.generation.repository import GenerationRepository

_logger = structlog.stdlib.get_logger(__name__)

QUEUE_POLL: Final = "generation-poll"

_STOP_MARGIN_SECONDS: Final = 5


def submit_queue(provider: str) -> str:
    return f"generation-submit-{provider}"


def _provider_of(job: GenerationJob) -> str:
    if job.provider is None:
        raise RuntimeError(f"生成记录 {job.id} 不交给执行方，不该进生成队列")
    return job.provider


def queue_dsn(database_url: str) -> str:
    scheme, _, rest = database_url.partition("://")
    return f"{scheme.split('+')[0]}://{rest}"


OnCompleted = Callable[[GenerationJob], Awaitable[None]]


class StillRunning(Exception):
    pass


@dataclass(frozen=True, slots=True)
class ProviderLane:
    provider: GenerationProvider
    concurrency: int
    timeout_seconds: int | None = None


def _by_name(lanes: Sequence[ProviderLane]) -> Mapping[str, ProviderLane]:
    by_name = {lane.provider.name: lane for lane in lanes}
    if len(by_name) != len(lanes):
        raise ValueError("同一个 provider 名字装配了两次")
    return by_name


@dataclass(frozen=True, slots=True)
class GenerationQueueSettings:
    poll_interval_seconds: int = 5

    error_retry_seconds: int = 30

    job_timeout_seconds: int = 3600

    video_submit_concurrency: int = 100

    compose_concurrency: int = 2

    poll_concurrency: int = 100

    shutdown_grace_seconds: int = 15

    stalled_worker_timeout_seconds: int = 30

    heartbeat_interval_seconds: int = 10


class _Retry(procrastinate.RetryStrategy):
    def __init__(self, settings: GenerationQueueSettings) -> None:
        super().__init__()
        self._settings = settings

    def get_retry_decision(
        self, *, exception: BaseException, job: QueuedJob
    ) -> RetryDecision | None:
        seconds = (
            self._settings.poll_interval_seconds
            if isinstance(exception, StillRunning)
            else self._settings.error_retry_seconds
        )
        return RetryDecision(retry_in={"seconds": seconds})


class GenerationQueue:
    def __init__(
        self,
        repo: GenerationRepository,
        *,
        lanes: Sequence[ProviderLane],
        connector: procrastinate.BaseConnector,
        settings: GenerationQueueSettings | None = None,
        on_completed: OnCompleted | None = None,
    ) -> None:

        self._repo = repo
        self._on_completed = on_completed
        self._lanes: Mapping[str, ProviderLane] = _by_name(lanes)
        self._settings = settings or GenerationQueueSettings()
        self._app = procrastinate.App(connector=connector)
        self._workers: tuple[asyncio.Task[None], ...] = ()

        retry = _Retry(self._settings)
        self._submit = self._app.task(
            name="generation.submit",
            queue=QUEUE_POLL,
            retry=retry,
        )(self.run_submit)
        self._poll = self._app.task(
            name="generation.poll",
            queue=QUEUE_POLL,
            retry=retry,
        )(self.run_poll)
        heal = self._app.task(
            name="generation.heal_stalled",
            queue=QUEUE_POLL,
            pass_context=True,
        )(self._heal_periodic)
        self._app.periodic(cron="* * * * *", periodic_id="generation-heal")(heal)

    @property
    def app(self) -> procrastinate.App:
        return self._app

    async def enqueue_submit(self, job: GenerationJob) -> None:
        await self._submit.configure(
            queue=submit_queue(_provider_of(job)),
            task_kwargs={"job_id": str(job.id)},
        ).defer_async()

    async def run_submit(self, job_id: str) -> None:
        job = await self._repo.get(uuid.UUID(job_id), owner=None)
        if job.status == STATUS_SUBMITTING:
            await self._fail_stranded(job)
            return
        if job.status == STATUS_SUBMITTED:
            _logger.info("生成任务已提交，补排首个轮询", job_id=job.id)
            await self._schedule_poll(job.id)
            return
        if job.status != STATUS_PENDING:
            _logger.info("生成任务已有结论，不再提交", job_id=job.id, status=job.status)
            return
        lane = self._lanes.get(_provider_of(job))
        if lane is None:
            await self._not_configured(job, only_if_status=STATUS_PENDING)
            return

        if await self._repo.mark_submitting(job.id) is None:
            _logger.info("生成任务在提交之前已有结论，不再提交", job_id=job.id)
            return
        try:
            submission = await lane.provider.submit(job)
        except ProviderError as exc:
            self._settled(
                job,
                await self._repo.mark_failed(
                    job.id,
                    error_code=exc.code,
                    error_message=str(exc),
                    only_if_status=STATUS_SUBMITTING,
                ),
            )
            _logger.warning(
                "生成任务提交失败",
                job_id=job.id,
                provider=job.provider,
                code=exc.code,
                error=str(exc),
            )
            return

        if submission.sentences is not None:
            self._settled(
                job,
                await self._repo.mark_transcribed(
                    job.id,
                    sentences=submission.sentences,
                    provider_status=submission.provider_status,
                    provider_task_id=submission.provider_task_id,
                    only_if_status=STATUS_SUBMITTING,
                ),
            )
            return

        if submission.output_url is not None:
            await self._completed(
                job,
                await self._repo.mark_completed(
                    job.id,
                    output=GenerationOutput(
                        url=submission.output_url, duration_ms=submission.duration_ms
                    ),
                    provider_status=submission.provider_status,
                    provider_task_id=submission.provider_task_id,
                    only_if_status=STATUS_SUBMITTING,
                ),
            )
            return

        await self._repo.mark_submitted(
            job.id,
            provider_task_id=submission.provider_task_id,
            provider_status=submission.provider_status,
        )
        await self._schedule_poll(job.id)

    async def _schedule_poll(self, job_id: uuid.UUID) -> None:
        await self._poll.configure(
            task_kwargs={"job_id": str(job_id)},
            schedule_in={"seconds": self._settings.poll_interval_seconds},
        ).defer_async()

    async def run_poll(self, job_id: str) -> None:
        job = await self._repo.get(uuid.UUID(job_id), owner=None)
        if job.status != STATUS_SUBMITTED:
            _logger.info("生成任务已有结论，不再轮询", job_id=job.id, status=job.status)
            return
        lane = self._lanes.get(_provider_of(job))
        timeout_seconds = self._timeout_seconds(lane)
        if self._timed_out(job, timeout_seconds):
            self._settled(
                job,
                await self._repo.mark_failed(
                    job.id,
                    error_code="PROVIDER_TIMEOUT",
                    error_message=f"提交后 {timeout_seconds} 秒仍无终态，按超时收尾",
                    only_if_status=STATUS_SUBMITTED,
                ),
            )
            return
        if lane is None:
            await self._not_configured(job, only_if_status=STATUS_SUBMITTED)
            return

        try:
            progress = await lane.provider.poll(job)
        except ProviderError as exc:
            if exc.retryable:
                raise
            self._settled(
                job,
                await self._repo.mark_failed(
                    job.id,
                    error_code=exc.code,
                    error_message=str(exc),
                    only_if_status=STATUS_SUBMITTED,
                ),
            )
            return

        if progress.outcome == "succeeded" and progress.output_url is not None:
            await self._completed(
                job,
                await self._repo.mark_completed(
                    job.id,
                    output=GenerationOutput(
                        url=progress.output_url,
                        watermark_url=progress.watermark_output_url,
                        duration_ms=progress.duration_ms,
                    ),
                    provider_status=progress.provider_status,
                    only_if_status=STATUS_SUBMITTED,
                ),
            )
            return
        if progress.outcome == "failed":
            self._settled(
                job,
                await self._repo.mark_failed(
                    job.id,
                    error_code=progress.error_code or "PROVIDER_FAILED",
                    error_message=progress.error_message or "provider 报告生成失败",
                    provider_status=progress.provider_status,
                    only_if_status=STATUS_SUBMITTED,
                ),
            )
            return

        await self._repo.record_progress(
            job.id,
            provider_status=progress.provider_status,
            only_if_status=STATUS_SUBMITTED,
            skip_unchanged=True,
        )
        raise StillRunning(f"{job.id} 还在跑（{progress.provider_status}）")

    async def heal_stalled(self, *, skip_job_id: int | None = None) -> int:
        stalled = await self._app.job_manager.get_stalled_jobs(
            seconds_since_heartbeat=self._settings.stalled_worker_timeout_seconds
        )
        healed = 0
        now = datetime.now(UTC)
        for queued in stalled:
            if queued.id is None or queued.id == skip_job_id:
                continue
            await self._app.job_manager.retry_job_by_id_async(job_id=queued.id, retry_at=now)
            healed += 1
        if healed:
            _logger.warning("捡回中断的生成任务（原 worker 已失联）", count=healed)
        return healed

    async def _heal_periodic(self, context: procrastinate.JobContext, timestamp: int) -> None:
        await self.heal_stalled(skip_job_id=context.job.id)

    def start(self) -> None:
        if self._workers:
            return
        settings = self._settings
        lanes = (
            *((submit_queue(name), lane.concurrency) for name, lane in self._lanes.items()),
            (QUEUE_POLL, settings.poll_concurrency),
        )
        self._workers = tuple(
            asyncio.create_task(
                self._app.run_worker_async(
                    queues=[queue],
                    name=queue,
                    concurrency=concurrency,
                    shutdown_graceful_timeout=settings.shutdown_grace_seconds,
                    update_heartbeat_interval=settings.heartbeat_interval_seconds,
                    stalled_worker_timeout=settings.stalled_worker_timeout_seconds,
                    install_signal_handlers=False,
                    delete_jobs="successful",
                ),
                name=f"generation-worker-{queue}",
            )
            for queue, concurrency in lanes
        )

    async def stop(self) -> None:
        if not self._workers:
            return
        workers, self._workers = self._workers, ()
        for worker in workers:
            worker.cancel()
        _, pending = await asyncio.wait(
            workers, timeout=self._settings.shutdown_grace_seconds + _STOP_MARGIN_SECONDS
        )
        for worker in pending:
            _logger.warning(
                "生成 worker 没在关停宽限期内收干净，不再等它", worker=worker.get_name()
            )

    async def _not_configured(
        self, job: GenerationJob, *, only_if_status: GenerationStatus
    ) -> None:
        failed = await self._repo.mark_failed(
            job.id,
            error_code="PROVIDER_NOT_CONFIGURED",
            error_message=f"装配里没有 {job.provider} 这家，本次不提交",
            only_if_status=only_if_status,
        )
        if failed is None:
            _logger.info("生成任务在收尾之前已有结论，不改它", job_id=job.id)
            return
        _logger.warning("生成任务的 provider 没配", job_id=job.id, provider=job.provider)

    async def _fail_stranded(self, job: GenerationJob) -> None:
        failed = await self._repo.mark_failed(
            job.id,
            error_code="SUBMIT_INTERRUPTED",
            error_message=(
                "提交中途进程中断，无法确认 provider 是否已收下这次生成；"
                "为免重复计费不自动重投，请确认后重新发起"
            ),
            only_if_status=STATUS_SUBMITTING,
        )
        if failed is None:
            _logger.info("生成任务在收尾之前已有结论，不改它", job_id=job.id)
            return
        _logger.warning("生成任务提交中断，已判失败", job_id=job.id)

    async def _completed(self, job: GenerationJob, written: GenerationJob | None) -> None:

        self._settled(job, written)
        if written is None or self._on_completed is None:
            return
        try:
            await self._on_completed(written)
        except Exception:
            _logger.exception("生成任务完成后的后续动作失败", job_id=written.id)

    def _settled(self, job: GenerationJob, written: GenerationJob | None) -> None:
        if written is None:
            _logger.info("生成任务在收尾之前已有结论，不改它", job_id=job.id)

    def _timeout_seconds(self, lane: ProviderLane | None) -> int:
        if lane is None or lane.timeout_seconds is None:
            return self._settings.job_timeout_seconds
        return lane.timeout_seconds

    @staticmethod
    def _timed_out(job: GenerationJob, timeout_seconds: int) -> bool:
        started = job.submitted_at or job.created_at
        elapsed = (datetime.now(UTC) - started).total_seconds()
        return elapsed > timeout_seconds


__all__ = [
    "QUEUE_POLL",
    "GenerationQueue",
    "GenerationQueueSettings",
    "OnCompleted",
    "ProviderLane",
    "StillRunning",
    "queue_dsn",
    "submit_queue",
]
