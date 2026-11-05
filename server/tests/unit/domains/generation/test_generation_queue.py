from __future__ import annotations

import uuid
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from procrastinate.exceptions import ConnectorException
from procrastinate.jobs import Job as QueuedJob
from procrastinate.testing import InMemoryConnector, JobRow
from procrastinate.types import JobToDefer

from iclip.domains.generation.models import (
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_SUBMITTED,
    STATUS_SUBMITTING,
    GenerationJob,
    GenerationOutput,
    GenerationStatus,
)
from iclip.domains.generation.provider import (
    ProviderError,
    ProviderProgress,
    ProviderSubmission,
)
from iclip.domains.generation.queue import (
    QUEUE_POLL,
    GenerationQueue,
    ProviderLane,
    StillRunning,
    submit_queue,
)
from tests.helpers.generation import (
    FAKE_IMAGE_PROVIDER,
    FAKE_VIDEO_PROVIDER,
    QUEUE_SETTINGS,
    InMemoryGenerationRepository,
    ScriptedProvider,
    build_queue,
    image_request,
    make_job,
    video_request,
)


class _PollDeferFailsOnce(InMemoryConnector):
    def __init__(self) -> None:
        super().__init__()
        self.poll_failures_left = 1

    async def defer_jobs_all(self, jobs: list[JobToDefer]) -> list[JobRow]:
        if self.poll_failures_left and any(job.task_name == "generation.poll" for job in jobs):
            self.poll_failures_left -= 1
            raise ConnectorException("排轮询时数据库连接断了")
        return await super().defer_jobs_all(jobs)


async def test_a_lost_first_poll_is_scheduled_when_the_submit_replays() -> None:
    job = make_job(video_request())
    repo = InMemoryGenerationRepository([job])
    video = ScriptedProvider(
        submission=ProviderSubmission(provider_task_id="t-1", provider_status="queued"),
        progress=ProviderProgress(
            outcome="succeeded",
            provider_status="succeeded",
            output_url="https://cdn.test/v.mp4",
        ),
    )
    connector = _PollDeferFailsOnce()
    queue, _ = build_queue(repo, video=video, connector=connector)

    with pytest.raises(ConnectorException):
        await queue.run_submit(str(job.id))
    assert repo.jobs[job.id].status == STATUS_SUBMITTED
    assert _polls(connector) == []
    waited = _retry_seconds(queue, ConnectorException("x"), task="generation.submit")
    assert waited == QUEUE_SETTINGS.error_retry_seconds, "排不上轮询要让提交任务过一会儿重来"

    await queue.run_submit(str(job.id))

    assert video.submit_calls == [job.id], "补排轮询不能再提交一次"
    assert len(_polls(connector)) == 1, "已提交的任务必须有人接着问结果，否则永远停在 submitted"

    await queue.run_poll(str(job.id))
    assert repo.jobs[job.id].status == STATUS_COMPLETED


def _polls(connector: InMemoryConnector) -> list[JobRow]:
    return [row for row in connector.jobs.values() if row["task_name"] == "generation.poll"]


async def test_submit_failure_is_terminal_even_when_retryable() -> None:
    job = make_job(video_request())
    repo = InMemoryGenerationRepository([job])
    video = ScriptedProvider(
        submission=ProviderError("超时了", code="PROVIDER_UNREACHABLE", retryable=True)
    )

    queue, _ = build_queue(repo, video=video)
    await queue.run_submit(str(job.id))

    stored = repo.jobs[job.id]
    assert stored.status == STATUS_FAILED
    assert stored.error_code == "PROVIDER_UNREACHABLE"


async def test_already_terminal_job_is_not_submitted_again() -> None:

    job = make_job(video_request(), status=STATUS_COMPLETED)
    repo = InMemoryGenerationRepository([job])
    video = ScriptedProvider(
        submission=ProviderSubmission(provider_task_id="t-1", provider_status="queued")
    )

    queue, _ = build_queue(repo, video=video)
    await queue.run_submit(str(job.id))

    assert video.submit_calls == []
    assert repo.jobs[job.id].status == STATUS_COMPLETED


async def test_poll_success_and_failure_reach_terminal_states() -> None:
    succeeded = make_job(video_request(), status=STATUS_SUBMITTED, provider_task_id="t-1")
    repo = InMemoryGenerationRepository([succeeded])
    video = ScriptedProvider(
        progress=ProviderProgress(
            outcome="succeeded",
            provider_status="succeeded",
            output_url="https://cdn.test/v.mp4",
        )
    )
    queue, _ = build_queue(repo, video=video)
    await queue.run_poll(str(succeeded.id))
    assert repo.jobs[succeeded.id].status == STATUS_COMPLETED

    failed = make_job(video_request(), status=STATUS_SUBMITTED, provider_task_id="t-2")
    repo = InMemoryGenerationRepository([failed])
    video = ScriptedProvider(
        progress=ProviderProgress(
            outcome="failed",
            provider_status="failed",
            error_code="NSFW",
            error_message="被拦了",
        )
    )
    queue, _ = build_queue(repo, video=video)
    await queue.run_poll(str(failed.id))
    assert repo.jobs[failed.id].error_code == "NSFW"


async def test_a_polled_result_lands_its_reported_duration_on_the_record() -> None:
    job = make_job(video_request(), status=STATUS_SUBMITTED, provider_task_id="t-1")
    repo = InMemoryGenerationRepository([job])
    video = ScriptedProvider(
        progress=ProviderProgress(
            outcome="succeeded",
            provider_status="succeeded",
            output_url="https://cdn.test/v.mp4",
            duration_ms=10042,
        )
    )
    queue, _ = build_queue(repo, video=video)
    await queue.run_poll(str(job.id))

    stored = repo.jobs[job.id]
    assert (stored.status, stored.output.duration_ms) == (STATUS_COMPLETED, 10042)


async def test_running_job_asks_again_at_a_fixed_interval() -> None:
    job = make_job(video_request(), status=STATUS_SUBMITTED, provider_task_id="t-1")
    repo = InMemoryGenerationRepository([job])
    video = ScriptedProvider(
        progress=ProviderProgress(outcome="running", provider_status="running")
    )
    queue, _ = build_queue(repo, video=video)

    with pytest.raises(StillRunning):
        await queue.run_poll(str(job.id))

    stored = repo.jobs[job.id]
    assert stored.status == STATUS_SUBMITTED, "还在跑不是失败"
    assert stored.provider_status == "running", "问到的东西要记下来"

    decision = _retry_seconds(queue, StillRunning("还在跑"))
    assert decision == QUEUE_SETTINGS.poll_interval_seconds


async def test_unreachable_provider_waits_longer_than_normal() -> None:
    job = make_job(video_request(), status=STATUS_SUBMITTED, provider_task_id="t-1")
    repo = InMemoryGenerationRepository([job])
    video = ScriptedProvider(
        progress=ProviderError("网络抖了", code="PROVIDER_UNREACHABLE", retryable=True)
    )

    queue, _ = build_queue(repo, video=video)
    with pytest.raises(ProviderError):
        await queue.run_poll(str(job.id))

    assert repo.jobs[job.id].status == STATUS_SUBMITTED, "问不通不改那次生成的结论"
    waited = _retry_seconds(queue, ProviderError("x", code="Y", retryable=True))
    assert waited > QUEUE_SETTINGS.poll_interval_seconds
    assert waited == QUEUE_SETTINGS.error_retry_seconds


async def test_non_retryable_poll_error_is_terminal() -> None:

    job = make_job(video_request(), status=STATUS_SUBMITTED, provider_task_id="t-1")
    repo = InMemoryGenerationRepository([job])
    video = ScriptedProvider(
        progress=ProviderError("没见过的状态", code="PROVIDER_BAD_STATUS", retryable=False)
    )

    queue, _ = build_queue(repo, video=video)
    await queue.run_poll(str(job.id))

    stored = repo.jobs[job.id]
    assert stored.status == STATUS_FAILED
    assert stored.error_code == "PROVIDER_BAD_STATUS"


async def test_job_stuck_running_forever_eventually_times_out() -> None:
    stale = datetime.now(UTC) - timedelta(seconds=QUEUE_SETTINGS.job_timeout_seconds + 60)
    job = make_job(
        video_request(),
        status=STATUS_SUBMITTED,
        provider_task_id="t-1",
        submitted_at=stale,
    )
    repo = InMemoryGenerationRepository([job])
    video = ScriptedProvider(
        progress=ProviderProgress(outcome="running", provider_status="running")
    )

    queue, _ = build_queue(repo, video=video)
    await queue.run_poll(str(job.id))

    stored = repo.jobs[job.id]
    assert stored.status == STATUS_FAILED
    assert stored.error_code == "PROVIDER_TIMEOUT"
    assert video.poll_calls == [], "超时先判掉，不再多问一次"


async def test_a_lane_with_its_own_time_limit_outlasts_the_default() -> None:
    default = QUEUE_SETTINGS.job_timeout_seconds
    stale = datetime.now(UTC) - timedelta(seconds=default * 2)
    slow_job = make_job(
        video_request(), status=STATUS_SUBMITTED, provider_task_id="t-1", submitted_at=stale
    )
    usual_job = make_job(
        image_request(), status=STATUS_SUBMITTED, provider_task_id="t-2", submitted_at=stale
    )
    repo = InMemoryGenerationRepository([slow_job, usual_job])
    running = ProviderProgress(outcome="running", provider_status="queued")
    slow = ScriptedProvider(name=FAKE_VIDEO_PROVIDER, progress=running)
    usual = ScriptedProvider(name=FAKE_IMAGE_PROVIDER, progress=running)
    queue, _ = build_queue(
        repo,
        lanes=(
            ProviderLane(slow, 1, timeout_seconds=default * 3),
            ProviderLane(usual, 1),
        ),
    )

    with pytest.raises(StillRunning):
        await queue.run_poll(str(slow_job.id))
    await queue.run_poll(str(usual_job.id))

    assert repo.jobs[slow_job.id].status == STATUS_SUBMITTED
    assert slow.poll_calls == [slow_job.id]
    timed_out = repo.jobs[usual_job.id]
    assert (timed_out.status, timed_out.error_code) == (STATUS_FAILED, "PROVIDER_TIMEOUT")
    assert timed_out.error_message is not None and str(default) in timed_out.error_message

    repo.jobs[slow_job.id] = replace(
        repo.jobs[slow_job.id],
        submitted_at=datetime.now(UTC) - timedelta(seconds=default * 3 + 60),
    )
    await queue.run_poll(str(slow_job.id))

    late = repo.jobs[slow_job.id]
    assert (late.status, late.error_code) == (STATUS_FAILED, "PROVIDER_TIMEOUT")
    assert late.error_message is not None and str(default * 3) in late.error_message


async def test_a_job_settled_between_reading_and_submitting_is_never_submitted() -> None:
    job = make_job(video_request())

    class CancelledMeanwhile(InMemoryGenerationRepository):
        async def get(self, *args: Any, **kwargs: Any) -> GenerationJob:
            read = await super().get(*args, **kwargs)
            await self.mark_failed(job.id, error_code="CANCELLED", error_message="导出已取消")
            return read

    repo = CancelledMeanwhile([job])
    video = ScriptedProvider(
        submission=ProviderSubmission(provider_task_id="t-1", provider_status="queued")
    )
    queue, _ = build_queue(repo, video=video)

    await queue.run_submit(str(job.id))

    stored = repo.jobs[job.id]
    assert (stored.status, stored.error_code) == (STATUS_FAILED, "CANCELLED")
    assert video.submit_calls == []


async def test_stranded_cleanup_never_overwrites_a_real_result() -> None:
    class CompletedDuringCleanup(InMemoryGenerationRepository):
        async def mark_failed(
            self,
            job_id: uuid.UUID,
            *,
            error_code: str,
            error_message: str,
            provider_status: str | None = None,
            only_if_status: GenerationStatus | None = None,
        ) -> GenerationJob | None:
            await self.mark_completed(
                job_id,
                output=GenerationOutput(url="https://cdn.test/out.png"),
                provider_status="succeeded",
            )
            return await super().mark_failed(
                job_id,
                error_code=error_code,
                error_message=error_message,
                provider_status=provider_status,
                only_if_status=only_if_status,
            )

    job = make_job(image_request(), status=STATUS_SUBMITTING)
    repo = CompletedDuringCleanup([job])

    queue, _ = build_queue(repo)
    await queue.run_submit(str(job.id))

    stored = repo.jobs[job.id]
    assert stored.status == STATUS_COMPLETED
    assert stored.output.url == "https://cdn.test/out.png"
    assert stored.error_code is None


async def test_submit_fails_loudly_when_the_provider_is_not_assembled() -> None:
    marked_submitting: list[uuid.UUID] = []

    class Recording(InMemoryGenerationRepository):
        async def mark_submitting(self, job_id: uuid.UUID) -> GenerationJob | None:
            marked_submitting.append(job_id)
            return await super().mark_submitting(job_id)

    job = make_job(image_request(), provider="没配过的一家")
    repo = Recording([job])
    image = ScriptedProvider(
        submission=ProviderSubmission(provider_task_id="t-1", provider_status="succeeded")
    )
    queue, _ = build_queue(repo, image=image)

    await queue.run_submit(str(job.id))

    stored = repo.jobs[job.id]
    assert stored.status == STATUS_FAILED
    assert stored.error_code == "PROVIDER_NOT_CONFIGURED"
    assert marked_submitting == [], "没配的家不该先占住 submitting"
    assert image.submit_calls == [], "别家的适配器不能替它提交"


async def test_poll_fails_loudly_when_the_provider_is_not_assembled() -> None:
    job = make_job(
        video_request(),
        status=STATUS_SUBMITTED,
        provider="没配过的一家",
        provider_task_id="t-1",
    )
    repo = InMemoryGenerationRepository([job])
    video = ScriptedProvider(
        progress=ProviderProgress(outcome="running", provider_status="running")
    )
    queue, _ = build_queue(repo, video=video)

    await queue.run_poll(str(job.id))

    stored = repo.jobs[job.id]
    assert stored.status == STATUS_FAILED
    assert stored.error_code == "PROVIDER_NOT_CONFIGURED"
    assert video.poll_calls == []


async def test_each_provider_goes_to_its_own_queue() -> None:
    video = make_job(video_request())
    image = make_job(image_request())
    repo = InMemoryGenerationRepository([video, image])
    queue, connector = build_queue(repo)

    await queue.enqueue_submit(video)
    await queue.enqueue_submit(image)

    routed = {row["queue_name"] for row in connector.jobs.values()}
    assert routed == {submit_queue(FAKE_VIDEO_PROVIDER), submit_queue(FAKE_IMAGE_PROVIDER)}


_ANY_JOB = QueuedJob(
    id=1, queue=QUEUE_POLL, lock=None, queueing_lock=None, task_name="generation.poll"
)


def _retry_seconds(
    queue: GenerationQueue, exception: Exception, *, task: str = "generation.poll"
) -> int:
    strategy = queue.app.tasks[task].retry_strategy
    assert strategy is not None
    decision = strategy.get_retry_decision(exception=exception, job=_ANY_JOB)
    assert decision is not None and decision.retry_at is not None
    return round((decision.retry_at - datetime.now(UTC)).total_seconds())
