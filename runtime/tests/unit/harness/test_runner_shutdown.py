from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from cue.harness.job_status import JobStatus
from cue.harness.jobs import JobQueue, JobRow
from cue.harness.step_store_pg import PgStepStore
from cue.harness.transcript.history import TranscriptHistory
from cue.harness.transcript.runner import ConversationRunner
from cue.harness.transcript.store import TranscriptStore
from cue.transcript.ops import TextContent
from tests.helpers.runtime import FixedAgents

pytestmark = pytest.mark.unit


class _InstantQueue(JobQueue):
    def __init__(self, engine: AsyncEngine) -> None:
        super().__init__(engine)
        self.finished: list[str] = []

    async def finish(
        self,
        prompt_id: str,
        *,
        status: JobStatus,
        now: datetime,
        locked_by: str,
        attempt: int,
        reason: str | None = None,
    ) -> None:
        self.finished.append(prompt_id)

    async def get(self, prompt_id: str) -> JobRow | None:
        return None

    async def start_next(self, conversation_id: str, *, locked_by: str) -> JobRow | None:
        return None


def _running_row() -> JobRow:
    return JobRow(
        prompt_id="prm_shutdown",
        conversation_id="c-shutdown",
        agent_id="storyboard",
        owner_user_id=uuid.UUID("11111111-2222-3333-4444-555555555555"),
        user_name="logan",
        content=(TextContent(text="写三个镜头"),),
        status="running",
        run_id=None,
        created_at=datetime.now(UTC),
        finished_at=None,
        steered_at=None,
        locked_by="w-test",
        heartbeat_at=datetime.now(UTC),
        interrupt_reason=None,
        attempt=0,
        decisions={},
    )


async def _no_deps(_row: JobRow) -> None:
    return None


async def test_shutdown_returns_when_a_finished_run_is_still_on_the_books() -> None:
    engine = create_async_engine(
        "postgresql+asyncpg://iclip:iclip@localhost:5432/nowhere", pool_pre_ping=True
    )
    queue = _InstantQueue(engine)
    step_store = PgStepStore(engine)
    runner = ConversationRunner(
        agents=FixedAgents({}, {}),
        store=TranscriptStore(),
        queue=queue,
        snapshots=step_store,
        history=TranscriptHistory(step_store, queue),
        deps_for=_no_deps,
        heartbeat_seconds=10,
        lease_seconds=30,
        sweep_seconds=15,
        max_attempts=2,
    )

    await runner.submit(_running_row())
    await asyncio.sleep(0)
    assert queue.finished == ["prm_shutdown"], "前提：运行已经跑完，只差回调摘名单"

    await runner.shutdown()
