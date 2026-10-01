"""历史重建走批量读：结果与逐个运行去查一模一样，查询条数不随运行数增长，子代理页不重建主流。"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable, Generator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from functools import partial
from typing import Any

from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai_harness.step_persistence import (
    ContinuableSnapshot,
    RunRecord,
    StepEvent,
    ToolEffectRecord,
)
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.harness.agents import DELEGATE_TOOL
from iclip.harness.jobs import JobQueue
from iclip.harness.step_store_pg import PgStepStore
from iclip.harness.transcript.history import TranscriptHistory, TranscriptHistoryView
from iclip.harness.transcript.service import TranscriptService
from iclip.harness.transcript.store import TranscriptStore
from iclip.platform.transcript.ops import MAIN_AGENT_ID
from tests.helpers.transcript import NoPromptRuns, PerRunBatchReads

T0 = datetime(2026, 9, 1, tzinfo=UTC)


class PerRunPgStore(PerRunBatchReads, PgStepStore):
    """参照实现：同一个库，批量读换成逐个运行去查。"""


@dataclass(frozen=True, slots=True)
class Seeded:
    conversation_id: str
    children: tuple[str, ...]


async def _seed(store: PgStepStore, *, runs: int, delegate_every: int) -> Seeded:
    """造一段对话：每 ``delegate_every`` 轮派一个下属运行，另有失败轮、被停轮与同刻开跑的两个下属。

    被停那轮派出的下属没有自己的终态，读出来要随父算 cancelled。
    """

    conversation_id = str(uuid.uuid4())
    messages: list[ModelMessage] = []
    children: list[str] = []
    run_id = ""
    for index in range(runs):
        run_id = f"main-{uuid.uuid4().hex[:8]}"
        at = T0 + timedelta(minutes=10 * index)
        ending = {1: "failed", 2: "cancelled"}.get(index, "completed")
        delegates = 2 if index == 3 else 1 if index == 2 or index % delegate_every == 0 else 0
        await store.register_run(
            RunRecord(
                run_id=run_id,
                conversation_id=conversation_id,
                agent_name="main",
                metadata={},
                started_at=at,
            )
        )
        await store.append_event(
            StepEvent(run_id=run_id, kind="run_started", step_index=0, timestamp=at)
        )
        calls = [f"call-{index}-{n}" for n in range(delegates)]
        messages.append(
            ModelRequest(parts=[UserPromptPart(content=f"第 {index} 轮")], run_id=run_id)
        )
        messages.append(
            ModelResponse(
                parts=[
                    TextPart(content=f"回复 {index}"),
                    *(
                        ToolCallPart(
                            tool_name=DELEGATE_TOOL,
                            args={"agent": "researcher", "task": f"任务 {call}"},
                            tool_call_id=call,
                        )
                        for call in calls
                    ),
                ],
                run_id=run_id,
            )
        )
        for n, call in enumerate(calls):
            child = str(uuid.uuid4())
            children.append(child)
            await store.record_tool_effect(
                ToolEffectRecord(
                    tool_call_id=call,
                    tool_name=DELEGATE_TOOL,
                    run_id=run_id,
                    status="completed",
                    effect_summary=child,
                    started_at=at,
                )
            )
            # 同一轮派出的下属同一时刻开跑，次序要稳定。
            await store.register_run(
                RunRecord(
                    run_id=child,
                    conversation_id=str(uuid.uuid4()),
                    parent_run_id=run_id,
                    agent_name="researcher",
                    metadata={"agent_name": "researcher", "model": "m-1"},
                    started_at=at + timedelta(seconds=1),
                )
            )
            if ending != "cancelled":
                await store.append_event(
                    StepEvent(
                        run_id=child,
                        kind="run_completed",
                        step_index=1,
                        timestamp=at + timedelta(seconds=2 + n),
                    )
                )
            await store.save_snapshot(
                ContinuableSnapshot(
                    run_id=child,
                    step_index=1,
                    parent_run_id=run_id,
                    messages=[
                        ModelRequest(parts=[UserPromptPart(content=f"任务 {call}")], run_id=child),
                        ModelResponse(parts=[TextPart(content=f"子结果 {call}")], run_id=child),
                    ],
                )
            )
            messages.append(
                ModelRequest(
                    parts=[
                        ToolReturnPart(
                            tool_name=DELEGATE_TOOL, content=f"子结果 {call}", tool_call_id=call
                        )
                    ],
                    run_id=run_id,
                )
            )
        ended = at + timedelta(seconds=30)
        if ending == "completed":
            await store.append_event(
                StepEvent(run_id=run_id, kind="run_completed", step_index=2, timestamp=ended)
            )
        else:
            error = "ValueError: 上游返回 500" if ending == "failed" else "CancelledError: 用户停止"
            await store.append_event(
                StepEvent(
                    run_id=run_id, kind="run_failed", step_index=2, timestamp=ended, error=error
                )
            )
    await store.save_snapshot(
        ContinuableSnapshot(
            run_id=run_id, step_index=2, messages=messages, conversation_id=conversation_id
        )
    )
    return Seeded(conversation_id=conversation_id, children=tuple(children))


def _history(store: PgStepStore) -> TranscriptHistory:
    return TranscriptHistory(store, NoPromptRuns(), delegate_tool=DELEGATE_TOOL)


@contextmanager
def _statements(engine: AsyncEngine) -> Generator[list[str]]:
    """数这段代码向库发了几条 SQL。"""

    seen: list[str] = []

    def count(*args: Any, **_: Any) -> None:
        seen.append(args[2])

    event.listen(engine.sync_engine, "before_cursor_execute", count)
    try:
        yield seen
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", count)


async def _count(engine: AsyncEngine, read: Callable[[], Awaitable[object]]) -> int:
    with _statements(engine) as seen:
        await read()
    return len(seen)


async def test_batch_reads_rebuild_the_same_history_as_per_run_reads(engine: AsyncEngine) -> None:
    store = PgStepStore(engine)
    seeded = await _seed(store, runs=8, delegate_every=3)
    batch, per_run = _history(store), _history(PerRunPgStore(engine))

    view = await batch.read(seeded.conversation_id)

    assert view == await per_run.read(seeded.conversation_id)
    assert await batch.read_tasks(seeded.conversation_id) == view.tasks
    for child in seeded.children:
        assert await batch.read_child(child) == await per_run.read_child(child)
    # 数据确实走到了要比的那几条分支：失败轮、被停轮带出的下属随父算 killed、同刻开跑的两个下属。
    assert [turn.state for turn in view.turns][:3] == ["completed", "failed", "cancelled"]
    assert any(task.state == "killed" for task in view.tasks)
    assert len(view.tasks) == len(seeded.children)


async def test_rebuild_issues_the_same_number_of_queries_for_10_or_50_runs(
    engine: AsyncEngine,
) -> None:
    store = PgStepStore(engine)
    small = await _seed(store, runs=10, delegate_every=5)
    large = await _seed(store, runs=50, delegate_every=5)
    history = _history(store)

    for read in (history.read, history.read_tasks):
        small_count = await _count(engine, partial(read, small.conversation_id))
        assert small_count == await _count(engine, partial(read, large.conversation_id))


@dataclass(frozen=True, slots=True)
class _ReadSpy(TranscriptHistory):
    """记下主流整段重建被调了几次。"""

    reads: list[str] = field(default_factory=list)

    async def read(self, conversation_id: str) -> TranscriptHistoryView:
        self.reads.append(conversation_id)
        return await TranscriptHistory.read(self, conversation_id)


async def test_child_page_does_not_rebuild_the_main_stream(engine: AsyncEngine) -> None:
    store = PgStepStore(engine)
    small = await _seed(store, runs=10, delegate_every=5)
    large = await _seed(store, runs=50, delegate_every=5)
    history = _ReadSpy(store, NoPromptRuns(), delegate_tool=DELEGATE_TOOL)

    async def noop(*_: object) -> None:
        return None

    no_runner: Any = None  # 子代理页不碰运行驱动
    service = TranscriptService(
        store=TranscriptStore(),
        history=history,
        queue=JobQueue(engine),
        runner=no_runner,
        context_limits={},
        record_materials=noop,
    )

    def child_page(seeded: Seeded) -> Callable[[], Awaitable[object]]:
        return lambda: service.page(
            seeded.conversation_id, agent_id=seeded.children[0], runtime_agent_id="main"
        )

    page = await service.page(
        large.conversation_id, agent_id=large.children[0], runtime_agent_id="main"
    )

    assert history.reads == []
    assert {agent.agent_id for agent in page.agents} == {MAIN_AGENT_ID, *large.children}
    assert await _count(engine, child_page(small)) == await _count(engine, child_page(large))
