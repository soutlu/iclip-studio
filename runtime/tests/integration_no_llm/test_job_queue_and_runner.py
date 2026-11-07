from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from pydantic_ai import Agent, AgentRunResult, Tool
from pydantic_ai.capabilities import AbstractCapability
from pydantic_ai.messages import (
    INTERRUPTED_TOOL_RETURN_CONTENT,
    ModelMessage,
    ModelRequest,
    ModelResponse,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai.models.function import (
    AgentInfo,
    DeltaToolCall,
    DeltaToolCalls,
    FunctionModel,
)
from pydantic_ai.tools import DeferredToolRequests, RunContext
from pydantic_ai_harness.step_persistence import StepPersistence
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine
from structlog.testing import capture_logs

from agent_runtime.errors import Conflict, NotFound, ValidationFailed
from agent_runtime.harness.jobs import JobQueue, JobRow
from agent_runtime.harness.step_store_pg import PgStepStore
from agent_runtime.harness.transcript.activity import IDLE, ActivityState
from agent_runtime.harness.transcript.from_messages import ORPHAN_TOOL_ERROR, run_ids_from_messages
from agent_runtime.harness.transcript.history import TranscriptHistory
from agent_runtime.harness.transcript.service import TranscriptService
from agent_runtime.harness.transcript.store import TranscriptStore
from agent_runtime.transcript.ops import (
    MAIN_AGENT_ID,
    AgentStatusMeta,
    AttachmentSource,
    ImageContent,
    PromptUpsertOp,
    TextContent,
    TextFrame,
    TranscriptTurn,
)
from tests.helpers.runtime import (
    AGENT_ID,
    DEAD,
    LOCKED_BY,
    MAX_CONTEXT_TOKENS,
    OWNER,
    approval_runner,
    awaits,
    build_runner,
    calls_tool,
    drained,
    expire_lease,
    first_run_messages,
    make_runner,
    plant_interrupted,
    prompt_text,
    replay,
    says,
    submit_text,
    texts,
    tool_cards,
    waits,
    wrote,
)


def _waits_twice(
    entered: tuple[asyncio.Event, asyncio.Event], gates: tuple[asyncio.Event, asyncio.Event]
) -> FunctionModel:
    asked = 0

    async def stream(
        _messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        nonlocal asked
        index = min(asked, 1)
        asked += 1
        entered[index].set()
        await gates[index].wait()
        yield "第一句" if index == 0 else "第二句"

    return FunctionModel(stream_function=stream)


def _speaks_then_waits(entered: asyncio.Event, gate: asyncio.Event) -> FunctionModel:
    async def stream(
        _messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        yield "先说一句"
        entered.set()
        await gate.wait()
        yield "说完了"

    return FunctionModel(stream_function=stream)


async def _live_context_status(
    store: TranscriptStore, conversation_id: str, *, tries: int = 200
) -> AgentStatusMeta:
    for _ in range(tries):
        status = store.subscribe_view(conversation_id, MAIN_AGENT_ID).snapshot.meta.agent
        if status is not None:
            return status
        await asyncio.sleep(0.02)
    raise AssertionError("运行中没收到上下文读数")


def _records(
    seen: list[list[ModelMessage]], entered: asyncio.Event, gate: asyncio.Event
) -> FunctionModel:
    async def stream(
        messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        seen.append(list(messages))
        if len(seen) == 1:
            entered.set()
            await gate.wait()
            yield "第一句"
        else:
            yield "补充收到了"

    return FunctionModel(stream_function=stream)


def _skeleton(turns: tuple[TranscriptTurn, ...]) -> list[Any]:
    return [
        (
            turn.turn_id,
            turn.ordinal,
            turn.state,
            turn.content,
            turn.error,
            [
                (
                    step.step_id,
                    step.ordinal,
                    [
                        (
                            frame.frame_id,
                            frame.kind,
                            getattr(frame, "text", None),
                            getattr(frame, "state", None),
                            getattr(frame, "output", None),
                            getattr(frame, "error", None),
                        )
                        for frame in step.frames
                    ],
                )
                for step in turn.steps
            ],
        )
        for turn in turns
    ]


async def test_second_prompt_queues_then_runs_after_the_first(engine: AsyncEngine) -> None:

    store = TranscriptStore()
    runner, step_store, queue = build_runner(engine, says("第一句", "第二句"), store=store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    first = await submit_text(runner, queue, conversation_id, "先做这个")
    second = await submit_text(runner, queue, conversation_id, "再做那个")

    queued = await queue.get(second)
    assert queued is not None
    assert queued.status == "queued"

    await drained(queue, conversation_id)
    await runner.shutdown()

    assert (await queue.get(first)) is not None
    settled = await queue.get(second)
    assert settled is not None
    assert settled.run_id is not None

    derived = (await TranscriptHistory(step_store, queue).read(conversation_id)).turns
    assert [prompt_text(turn) for turn in derived] == ["先做这个", "再做那个"]
    assert [turn.ordinal for turn in derived] == [1, 2]


async def test_usage_is_filled_in_when_the_run_finishes(engine: AsyncEngine) -> None:

    store = TranscriptStore()
    runner, step_store, queue = build_runner(engine, says("好"), store=store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    await submit_text(runner, queue, conversation_id, "来")
    await runner.shutdown()

    turn = replay(store, conversation_id)[0]
    assert turn.usage is not None
    usage = turn.steps[0].usage
    assert usage is not None

    live_status = store.subscribe_view(conversation_id, MAIN_AGENT_ID).snapshot.meta.agent
    assert live_status is not None
    assert live_status.context_tokens == (
        usage.input_other + usage.output + usage.input_cache_read + usage.input_cache_creation
    )
    assert live_status.max_context_tokens == MAX_CONTEXT_TOKENS

    restored = await TranscriptService(
        store=TranscriptStore(),
        history=TranscriptHistory(step_store, queue),
        queue=queue,
        runner=runner,
    ).page(conversation_id, runtime_agent_id=AGENT_ID)
    assert restored.meta.agent == live_status


async def test_the_context_gauge_updates_before_the_run_finishes(engine: AsyncEngine) -> None:
    entered, gate = asyncio.Event(), asyncio.Event()
    store = TranscriptStore()
    runner, _step_store, queue = build_runner(
        engine, _speaks_then_waits(entered, gate), store=store
    )
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    await submit_text(runner, queue, conversation_id, "来")
    await entered.wait()
    try:
        status = await _live_context_status(store, conversation_id)
    finally:
        gate.set()
        await drained(queue, conversation_id)
        await runner.shutdown()

    assert status.max_context_tokens == MAX_CONTEXT_TOKENS


async def test_sweep_settles_an_expired_lease_and_wakes_the_queue(engine: AsyncEngine) -> None:
    store = TranscriptStore()
    runner, _step_store, queue = build_runner(engine, says("轮到我了"), store=store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"
    now = datetime.now(UTC)
    first, _ = await queue.submit(
        prompt_id="prm_a",
        conversation_id=conversation_id,
        agent_id=AGENT_ID,
        owner_user_id=OWNER,
        user_name="logan",
        content=(TextContent(text="一"),),
        now=now,
        locked_by=DEAD,
    )
    second, _ = await queue.submit(
        prompt_id="prm_b",
        conversation_id=conversation_id,
        agent_id=AGENT_ID,
        owner_user_id=OWNER,
        user_name="logan",
        content=(TextContent(text="二"),),
        now=now,
        locked_by=DEAD,
    )
    assert (first.status, second.status) == ("running", "queued")

    await expire_lease(engine, conversation_id, attempt=1)
    await runner.sweep_once()
    await drained(queue, conversation_id)
    await runner.shutdown()

    lost = await queue.get("prm_a")
    assert lost is not None
    assert lost.status == "failed"
    assert lost.interrupt_reason
    assert lost.locked_by is None

    woken = await queue.get("prm_b")
    assert woken is not None
    assert woken.status == "completed"
    assert woken.run_id is not None
    assert woken.locked_by == runner.locked_by


async def test_an_interrupted_prompt_resumes_into_the_same_turn(engine: AsyncEngine) -> None:
    store = TranscriptStore()
    runner, step_store, queue = build_runner(engine, says("接着写完了"), store=store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"
    first_run = f"{AGENT_ID}-dead"
    prompt_id = await plant_interrupted(
        engine,
        step_store,
        queue,
        conversation_id,
        run_id=first_run,
        messages=first_run_messages(first_run),
    )

    await runner.sweep_once()
    await drained(queue, conversation_id)
    await runner.shutdown()

    row = await queue.get(prompt_id)
    assert row is not None
    assert row.status == "completed"
    assert row.attempt == 1
    assert row.run_id != first_run
    assert set(await queue.prompt_of_runs(conversation_id)) == {first_run, row.run_id}

    derived = (await TranscriptHistory(step_store, queue).read(conversation_id)).turns
    assert [(turn.turn_id, turn.state) for turn in derived] == [("t1", "completed")]
    steps = derived[0].steps
    assert [step.state for step in steps] == ["interrupted", "completed"]
    assert [frame for frame in steps[0].frames if getattr(frame, "role", None) == "user"] == []
    assert [getattr(frame, "text", None) for frame in steps[1].frames] == ["接着写完了"]

    replayed = replay(store, conversation_id)
    assert _skeleton(replayed) == _skeleton(derived)
    assert [step.state for step in replayed[0].steps] == ["interrupted", "completed"]


def _mid_tool_cycle_messages(run_id: str) -> list[ModelMessage]:
    started = datetime(2026, 9, 1, 10, 0, tzinfo=UTC)
    return [
        ModelRequest(
            parts=[UserPromptPart(content="把这三个镜头出图")], run_id=run_id, timestamp=started
        ),
        ModelResponse(
            parts=[
                ToolCallPart(tool_name="draft", args="{}", tool_call_id="call_1"),
                ToolCallPart(tool_name="draft", args="{}", tool_call_id="call_2"),
            ],
            run_id=run_id,
            timestamp=started,
        ),
        ModelRequest(
            parts=[ToolReturnPart(tool_name="draft", content="出好了", tool_call_id="call_1")],
            run_id=run_id,
            timestamp=started,
            state="interrupted",
        ),
    ]


async def test_a_run_interrupted_mid_tool_cycle_is_repaired_by_the_official_path(
    engine: AsyncEngine,
) -> None:
    store = TranscriptStore()
    runner, step_store, queue = build_runner(engine, says("剩下那张也出好了"), store=store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"
    first_run = f"{AGENT_ID}-dead"
    await plant_interrupted(
        engine,
        step_store,
        queue,
        conversation_id,
        run_id=first_run,
        messages=_mid_tool_cycle_messages(first_run),
    )

    await runner.sweep_once()
    await drained(queue, conversation_id)
    await runner.shutdown()

    snapshot = await step_store.latest_conversation_snapshot(
        conversation_id=conversation_id, include_interrupted=True
    )
    assert snapshot is not None
    returns = {
        part.tool_call_id: part
        for message in snapshot.messages
        for part in getattr(message, "parts", ())
        if isinstance(part, ToolReturnPart)
    }
    repaired = returns["call_2"]
    assert repaired.outcome == "interrupted"
    assert repaired.content == INTERRUPTED_TOOL_RETURN_CONTENT
    assert repaired.metadata
    assert texts(list(snapshot.messages)) == ["把这三个镜头出图"]

    derived = (await TranscriptHistory(step_store, queue).read(conversation_id)).turns
    cards = {card.tool_call_id: card for card in tool_cards(derived)}
    assert cards["call_1"].state == "done"
    assert (cards["call_2"].state, cards["call_2"].error) == ("error", ORPHAN_TOOL_ERROR)

    replayed = replay(store, conversation_id)
    live = {card.tool_call_id: card for card in tool_cards(replayed)}
    assert (live["call_2"].state, live["call_2"].output, live["call_2"].error) == (
        "error",
        None,
        ORPHAN_TOOL_ERROR,
    )
    assert _skeleton(replayed) == _skeleton(derived)


async def test_a_run_interrupted_before_any_tool_return_re_executes_the_frontier(
    engine: AsyncEngine,
) -> None:
    ran = 0

    def draft() -> str:
        nonlocal ran
        ran += 1
        return "出好了"

    store = TranscriptStore()
    runner, step_store, queue = build_runner(
        engine, says("三张都出好了"), store=store, tools=[draft]
    )
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"
    first_run = f"{AGENT_ID}-dead"
    started = datetime(2026, 9, 1, 10, 0, tzinfo=UTC)
    prompt_id = await plant_interrupted(
        engine,
        step_store,
        queue,
        conversation_id,
        run_id=first_run,
        messages=[
            ModelRequest(
                parts=[UserPromptPart(content="把这三个镜头出图")],
                run_id=first_run,
                timestamp=started,
            ),
            ModelResponse(
                parts=[ToolCallPart(tool_name="draft", args="{}", tool_call_id="call_1")],
                run_id=first_run,
                timestamp=started,
            ),
        ],
    )

    await runner.sweep_once()
    await drained(queue, conversation_id)
    await runner.shutdown()

    row = await queue.get(prompt_id)
    assert row is not None
    assert (row.status, row.attempt) == ("completed", 1)
    assert ran == 1

    derived = (await TranscriptHistory(step_store, queue).read(conversation_id)).turns
    card = tool_cards(derived)[0]
    assert (card.state, card.output) == ("done", "出好了")
    replayed = replay(store, conversation_id)
    live = tool_cards(replayed)[0]
    assert (live.state, live.output) == ("done", "出好了")
    assert _skeleton(replayed) == _skeleton(derived)


async def test_a_graceful_shutdown_releases_the_lease_for_a_later_resume(
    engine: AsyncEngine,
) -> None:
    entered = (asyncio.Event(), asyncio.Event())
    gates = (asyncio.Event(), asyncio.Event())
    store = TranscriptStore()
    runner, _step_store, queue = build_runner(engine, _waits_twice(entered, gates), store=store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    first = await submit_text(runner, queue, conversation_id, "先做这个")
    second = await submit_text(runner, queue, conversation_id, "临时插一句")
    await entered[0].wait()
    await runner.steer(conversation_id, (second,))
    gates[0].set()
    await entered[1].wait()

    await runner.shutdown()

    released = await queue.get(first)
    assert released is not None
    assert released.status == "running"
    assert released.locked_by is None
    assert released.interrupt_reason
    appended = await queue.get(second)
    assert appended is not None
    assert appended.status == "steered"

    store2 = TranscriptStore()
    runner2, _step_store2, queue2 = build_runner(engine, says("接着写完了"), store=store2)
    await runner2.sweep_once()
    await drained(queue2, conversation_id)
    await runner2.shutdown()

    resumed = await queue.get(first)
    assert resumed is not None
    assert resumed.status == "completed"
    assert resumed.attempt == 1
    settled = await queue.get(second)
    assert settled is not None
    assert settled.status == "completed"
    assert settled.run_id == resumed.run_id


async def test_sweep_does_not_claim_a_row_this_process_is_still_running(
    engine: AsyncEngine,
) -> None:
    entered, gate = asyncio.Event(), asyncio.Event()
    store = TranscriptStore()
    runner, _step_store, queue = build_runner(engine, waits(entered, gate), store=store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    prompt_id = await submit_text(runner, queue, conversation_id, "先做这个")
    await entered.wait()
    await expire_lease(engine, conversation_id)

    await runner.sweep_once()

    stale = await queue.get(prompt_id)
    assert stale is not None
    assert stale.attempt == 0
    assert stale.locked_by == runner.locked_by

    gate.set()
    await drained(queue, conversation_id)
    await runner.shutdown()

    assert [prompt_text(turn) for turn in replay(store, conversation_id)] == ["先做这个"]


async def test_a_prompt_that_used_up_its_attempts_is_failed(engine: AsyncEngine) -> None:
    store = TranscriptStore()
    runner, step_store, queue = build_runner(engine, says("不该跑到我"), store=store)
    for attempt in (1, 2):
        conversation_id = f"c-{uuid.uuid4().hex[:8]}"
        run_id = f"{AGENT_ID}-dead-{attempt}"
        prompt_id = await plant_interrupted(
            engine,
            step_store,
            queue,
            conversation_id,
            run_id=run_id,
            messages=first_run_messages(run_id),
            attempt=attempt,
        )
        appended = await submit_text(runner, queue, conversation_id, "临时插一句")
        await queue.mark_steered((appended,), run_id=run_id, now=datetime.now(UTC))

        await runner.sweep_once()

        row = await queue.get(prompt_id)
        assert row is not None
        assert row.status == "failed"
        assert row.interrupt_reason
        assert row.locked_by is None
        assert row.attempt == attempt
        child = await queue.get(appended)
        assert child is not None
        assert child.status == "failed"
    await runner.shutdown()


async def test_a_prompt_interrupted_before_its_first_snapshot_runs_again(
    engine: AsyncEngine,
) -> None:
    store = TranscriptStore()
    runner, step_store, queue = build_runner(engine, says("这次跑完了"), store=store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"
    prompt_id = await plant_interrupted(
        engine, step_store, queue, conversation_id, run_id=f"{AGENT_ID}-dead"
    )

    await runner.sweep_once()
    await drained(queue, conversation_id)
    await runner.shutdown()

    row = await queue.get(prompt_id)
    assert row is not None
    assert row.status == "completed"
    assert row.attempt == 1

    derived = (await TranscriptHistory(step_store, queue).read(conversation_id)).turns
    assert [(turn.turn_id, turn.ordinal, prompt_text(turn)) for turn in derived] == [
        ("t1", 1, "把这三个镜头出图")
    ]
    assert _skeleton(replay(store, conversation_id)) == _skeleton(derived)


async def test_a_live_lease_is_left_alone(engine: AsyncEngine) -> None:

    runner, _step_store, queue = build_runner(engine, says("好"), store=TranscriptStore())
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"
    await queue.submit(
        prompt_id="prm_live",
        conversation_id=conversation_id,
        agent_id=AGENT_ID,
        owner_user_id=OWNER,
        user_name="logan",
        content=(TextContent(text="别人在跑"),),
        now=datetime.now(UTC),
        locked_by="w-other",
    )

    await runner.sweep_once()
    await runner.shutdown()

    row = await queue.get("prm_live")
    assert row is not None
    assert row.status == "running"
    assert row.locked_by == "w-other"


async def test_a_queued_prompt_survives_a_restart_and_gets_picked_up(
    engine: AsyncEngine,
) -> None:

    queue = JobQueue(engine)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"
    now = datetime.now(UTC)
    for prompt_id, said in (("prm_head", "先做这个"), ("prm_tail", "再做那个")):
        await queue.submit(
            prompt_id=prompt_id,
            conversation_id=conversation_id,
            agent_id=AGENT_ID,
            owner_user_id=OWNER,
            user_name="logan",
            content=(TextContent(text=said),),
            now=now,
            locked_by=DEAD,
        )
    await queue.finish("prm_head", status="completed", now=now, locked_by=DEAD, attempt=0)

    runner, _step_store, _queue = build_runner(engine, says("轮到我了"), store=TranscriptStore())
    await runner.sweep_once()
    await drained(queue, conversation_id)
    await runner.shutdown()

    tail = await queue.get("prm_tail")
    assert tail is not None
    assert tail.status == "completed"
    assert tail.locked_by == runner.locked_by


async def test_a_run_whose_lease_was_taken_cancels_itself(engine: AsyncEngine) -> None:
    entered, gate = asyncio.Event(), asyncio.Event()
    store = TranscriptStore()
    runner, _step_store, queue = build_runner(engine, waits(entered, gate), store=store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    prompt_id = await submit_text(runner, queue, conversation_id, "先做这个")
    await entered.wait()

    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE agent_runtime.agent_jobs SET locked_by = 'w-other' WHERE prompt_id = :id"),
            {"id": prompt_id},
        )
    await runner.heartbeat_once()
    gate.set()
    await runner.shutdown()

    assert [turn.state for turn in replay(store, conversation_id)] == ["cancelled"]

    row = await queue.get(prompt_id)
    assert row is not None
    assert row.status == "running"
    assert row.locked_by == "w-other"
    assert row.finished_at is None


async def test_a_run_that_lost_its_lease_before_starting_does_nothing(engine: AsyncEngine) -> None:
    model_requests = 0

    async def stream(
        _messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        nonlocal model_requests
        model_requests += 1
        yield "不该跑到这里"

    started: list[str] = []

    async def note(_row: JobRow, run_id: str) -> None:
        started.append(run_id)

    store = TranscriptStore()
    runner, step_store, queue = build_runner(
        engine, FunctionModel(stream_function=stream), store=store, on_run_started=note
    )
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"
    now = datetime.now(UTC)
    for prompt_id, said in (("prm_stale", "先做这个"), ("prm_steer", "顺便改个标题")):
        await queue.submit(
            prompt_id=prompt_id,
            conversation_id=conversation_id,
            agent_id=AGENT_ID,
            owner_user_id=OWNER,
            user_name="logan",
            content=(TextContent(text=said),),
            now=now,
            locked_by=runner.locked_by,
        )
    await queue.attach_run("prm_stale", "r-old", locked_by=runner.locked_by, attempt=0)
    await queue.mark_steered(("prm_steer",), run_id="r-old", now=now)
    stale = await queue.get("prm_stale")
    assert stale is not None
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "UPDATE agent_runtime.agent_jobs SET locked_by = 'w-other', attempt = 1 "
                "WHERE prompt_id = 'prm_stale'"
            )
        )
    await runner.submit(stale)
    await runner.shutdown()

    assert model_requests == 0
    assert started == []
    row = await queue.get("prm_stale")
    assert row is not None
    assert (row.status, row.locked_by, row.run_id, row.finished_at) == (
        "running",
        "w-other",
        "r-old",
        None,
    )
    steered = await queue.get("prm_steer")
    assert steered is not None
    assert (steered.status, steered.run_id) == ("steered", "r-old")
    assert await queue.prompt_of_runs(conversation_id) == {"r-old": "prm_stale"}
    assert (
        await step_store.latest_conversation_snapshot(
            conversation_id=conversation_id, include_interrupted=True
        )
        is None
    )
    assert replay(store, conversation_id) == ()


async def test_only_the_running_row_carries_a_lease(engine: AsyncEngine) -> None:

    queue = JobQueue(engine)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"
    now = datetime.now(UTC)
    rows = [
        await queue.submit(
            prompt_id=prompt_id,
            conversation_id=conversation_id,
            agent_id=AGENT_ID,
            owner_user_id=OWNER,
            user_name="logan",
            content=(TextContent(text=said),),
            now=now,
            locked_by=LOCKED_BY,
        )
        for prompt_id, said in (("prm_head", "先做这个"), ("prm_tail", "再做那个"))
    ]
    (head, _), (tail, _) = rows
    assert head.locked_by == LOCKED_BY
    assert head.heartbeat_at is not None
    assert (tail.locked_by, tail.heartbeat_at) == (None, None)

    await queue.finish("prm_head", status="completed", now=now, locked_by=LOCKED_BY, attempt=0)
    started = await queue.start_next(conversation_id, locked_by="w-next")
    assert started is not None
    assert started.locked_by == "w-next"
    assert started.heartbeat_at is not None


async def test_attach_run_maps_every_run_to_its_prompt(engine: AsyncEngine) -> None:
    queue = JobQueue(engine)
    now = datetime.now(UTC)
    for prompt_id, conversation_id in (("prm_mine", "c-mine"), ("prm_yours", "c-yours")):
        await queue.submit(
            prompt_id=prompt_id,
            conversation_id=conversation_id,
            agent_id=AGENT_ID,
            owner_user_id=OWNER,
            user_name="logan",
            content=(TextContent(text="走"),),
            now=now,
            locked_by=LOCKED_BY,
        )
    assert await queue.attach_run("prm_mine", "r-first", locked_by=LOCKED_BY, attempt=0) is True
    await queue.attach_run("prm_mine", "r-second", locked_by=LOCKED_BY, attempt=0)
    await queue.attach_run("prm_yours", "r-other", locked_by=LOCKED_BY, attempt=0)

    assert await queue.prompt_of_runs("c-mine") == {
        "r-first": "prm_mine",
        "r-second": "prm_mine",
    }
    assert await queue.prompt_of_runs("c-yours") == {"r-other": "prm_yours"}

    first = await queue.get_by_run("r-first", conversation_id="c-mine")
    second = await queue.get_by_run("r-second", conversation_id="c-mine")
    assert first is not None
    assert second is not None
    assert (first.prompt_id, second.prompt_id) == ("prm_mine", "prm_mine")
    assert second.run_id == "r-second"
    assert await queue.get_by_run("r-other", conversation_id="c-mine") is None


async def test_attach_run_writes_nothing_when_the_lease_moved_on(engine: AsyncEngine) -> None:
    queue = JobQueue(engine)
    await queue.submit(
        prompt_id="prm_fenced",
        conversation_id="c-fenced",
        agent_id=AGENT_ID,
        owner_user_id=OWNER,
        user_name="logan",
        content=(TextContent(text="走"),),
        now=datetime.now(UTC),
        locked_by=LOCKED_BY,
    )

    attached = await queue.attach_run("prm_fenced", "r-stale", locked_by="w-other", attempt=0)

    row = await queue.get("prm_fenced")
    assert attached is False
    assert row is not None
    assert row.run_id is None
    assert await queue.prompt_of_runs("c-fenced") == {}
    assert (await queue.get_by_run("r-stale", conversation_id="c-fenced")) is None


@pytest.mark.parametrize("same_worker", [True, False], ids=["same-worker", "other-worker"])
@pytest.mark.parametrize("concurrent", [False, True], ids=["retry-running", "concurrent"])
async def test_repeated_prompt_receipts_do_not_run_the_model_twice(
    engine: AsyncEngine, same_worker: bool, concurrent: bool
) -> None:
    entered, gate = asyncio.Event(), asyncio.Event()
    model_requests = 0

    async def stream(
        _messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        nonlocal model_requests
        model_requests += 1
        entered.set()
        await gate.wait()
        yield "只执行一次"

    model = FunctionModel(stream_function=stream)

    def service() -> TranscriptService:
        store = TranscriptStore()
        runner, step_store, queue = build_runner(engine, model, store=store)
        return TranscriptService(
            store=store,
            history=TranscriptHistory(step_store, queue),
            queue=queue,
            runner=runner,
        )

    first = service()
    retry = first if same_worker else service()
    services = [first] if same_worker else [first, retry]
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    async def submit(target: TranscriptService) -> str:
        received = await target.submit(
            prompt_id="prm_same_receipt",
            conversation_id=conversation_id,
            agent_id=AGENT_ID,
            owner_user_id=OWNER,
            user_name="logan",
            content=(TextContent(text="开始创作"),),
        )
        return received.prompt_id

    try:
        if concurrent:
            received = await asyncio.gather(submit(first), submit(retry))
            await asyncio.wait_for(entered.wait(), timeout=5)
        else:
            initial = await submit(first)
            await asyncio.wait_for(entered.wait(), timeout=5)
            received = [initial, await submit(retry)]
        assert received == ["prm_same_receipt", "prm_same_receipt"]
        gate.set()
        await drained(first.queue, conversation_id)
    finally:
        gate.set()
        await asyncio.gather(*(target.runner.shutdown() for target in services))

    assert model_requests == 1
    runs = await first.history.store.list_runs(conversation_id=conversation_id)
    assert len(runs) == 1


async def test_resubmitting_the_same_prompt_id_returns_the_existing_row(
    engine: AsyncEngine,
) -> None:

    queue = JobQueue(engine)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"
    now = datetime.now(UTC)
    for expected_created in (True, False):
        row, created = await queue.submit(
            prompt_id="prm_same",
            conversation_id=conversation_id,
            agent_id=AGENT_ID,
            owner_user_id=OWNER,
            user_name="logan",
            content=(TextContent(text="一"),),
            now=now,
            locked_by=LOCKED_BY,
        )
        assert row.prompt_id == "prm_same"
        assert created is expected_created
    view = await queue.view(conversation_id)
    assert view.active is not None
    assert view.queued == ()


async def test_the_same_prompt_id_in_another_conversation_is_rejected(
    engine: AsyncEngine,
) -> None:
    queue = JobQueue(engine)
    now = datetime.now(UTC)
    await queue.submit(
        prompt_id="prm_shared",
        conversation_id="c-mine",
        agent_id=AGENT_ID,
        owner_user_id=OWNER,
        user_name="logan",
        content=(TextContent(text="我的"),),
        now=now,
        locked_by=LOCKED_BY,
    )
    with pytest.raises(Conflict):
        await queue.submit(
            prompt_id="prm_shared",
            conversation_id="c-yours",
            agent_id=AGENT_ID,
            owner_user_id=OWNER,
            user_name="logan",
            content=(TextContent(text="你的"),),
            now=now,
            locked_by=LOCKED_BY,
        )


async def test_the_same_prompt_id_submitted_twice_at_once_lands_as_one_row(
    engine: AsyncEngine,
) -> None:
    queue = JobQueue(engine)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"
    now = datetime.now(UTC)

    async def once() -> tuple[JobRow, bool]:
        return await queue.submit(
            prompt_id="prm_doubled",
            conversation_id=conversation_id,
            agent_id=AGENT_ID,
            owner_user_id=OWNER,
            user_name="logan",
            content=(TextContent(text="一"),),
            now=now,
            locked_by=LOCKED_BY,
        )

    (first, first_created), (second, second_created) = await asyncio.gather(once(), once())

    assert (first.prompt_id, second.prompt_id) == ("prm_doubled", "prm_doubled")
    assert first_created != second_created
    view = await queue.view(conversation_id)
    assert view.active is not None
    assert view.queued == ()


async def test_a_write_from_an_older_attempt_changes_nothing(engine: AsyncEngine) -> None:
    queue = JobQueue(engine)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"
    now = datetime.now(UTC)
    await queue.submit(
        prompt_id="prm_fenced_attempt",
        conversation_id=conversation_id,
        agent_id=AGENT_ID,
        owner_user_id=OWNER,
        user_name="logan",
        content=(TextContent(text="走"),),
        now=now,
        locked_by=LOCKED_BY,
    )
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "UPDATE agent_runtime.agent_jobs SET attempt = 1 "
                "WHERE prompt_id = 'prm_fenced_attempt'"
            )
        )

    await queue.finish(
        "prm_fenced_attempt", status="completed", now=now, locked_by=LOCKED_BY, attempt=0
    )
    stale = await queue.get("prm_fenced_attempt")
    assert stale is not None
    assert stale.status == "running"

    await queue.finish(
        "prm_fenced_attempt", status="completed", now=now, locked_by=LOCKED_BY, attempt=1
    )
    settled = await queue.get("prm_fenced_attempt")
    assert settled is not None
    assert settled.status == "completed"


async def test_a_message_withdrawn_while_queued_is_not_the_last_turn_reason(
    engine: AsyncEngine,
) -> None:
    queue = JobQueue(engine)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"
    now = datetime.now(UTC)
    for prompt_id, said in (("prm_ran", "先做这个"), ("prm_withdrawn", "再做那个")):
        await queue.submit(
            prompt_id=prompt_id,
            conversation_id=conversation_id,
            agent_id=AGENT_ID,
            owner_user_id=OWNER,
            user_name="logan",
            content=(TextContent(text=said),),
            now=now,
            locked_by=LOCKED_BY,
        )
    await queue.finish("prm_ran", status="completed", now=now, locked_by=LOCKED_BY, attempt=0)
    await queue.abort(
        "prm_withdrawn", conversation_id=conversation_id, now=now + timedelta(minutes=1)
    )

    assert await queue.activities((conversation_id,)) == {
        conversation_id: ActivityState(busy=False, last_turn_reason="completed")
    }


async def test_an_append_riding_the_turn_does_not_hide_the_approval(
    engine: AsyncEngine,
) -> None:

    queue = JobQueue(engine)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"
    now = datetime.now(UTC)
    for prompt_id, said in (("prm_parked", "改这个文件"), ("prm_appended", "顺便还有")):
        await queue.submit(
            prompt_id=prompt_id,
            conversation_id=conversation_id,
            agent_id=AGENT_ID,
            owner_user_id=OWNER,
            user_name="logan",
            content=(TextContent(text=said),),
            now=now,
            locked_by=LOCKED_BY,
        )
    run_id = f"{AGENT_ID}-parked"
    await queue.attach_run("prm_parked", run_id, locked_by=LOCKED_BY, attempt=0)
    assert (await queue.await_approvals("prm_parked", locked_by=LOCKED_BY, attempt=0)) is not None
    await queue.mark_steered(("prm_appended",), run_id=run_id, now=now)

    assert await queue.activities((conversation_id,)) == {
        conversation_id: ActivityState(busy=True, pending_interaction="approval")
    }


async def test_busy_conversations_are_the_ones_holding_a_job(engine: AsyncEngine) -> None:
    queue = JobQueue(engine)
    now = datetime.now(UTC)
    running_id = f"c-{uuid.uuid4().hex[:8]}"
    done_id = f"c-{uuid.uuid4().hex[:8]}"
    untouched_id = f"c-{uuid.uuid4().hex[:8]}"
    for prompt_id, conversation_id in (("prm_a", running_id), ("prm_b", done_id)):
        await queue.submit(
            prompt_id=prompt_id,
            conversation_id=conversation_id,
            agent_id=AGENT_ID,
            owner_user_id=OWNER,
            user_name="logan",
            content=(TextContent(text="走"),),
            now=now,
            locked_by=LOCKED_BY,
        )
    await queue.finish("prm_b", status="completed", now=now, locked_by=LOCKED_BY, attempt=0)

    assert await queue.busy_conversation_ids(OWNER) == frozenset({running_id})
    assert await queue.busy_conversation_ids(None) == frozenset({running_id})
    assert await queue.busy_conversation_ids(uuid.uuid4()) == frozenset()
    assert await queue.activities((untouched_id,)) == {untouched_id: IDLE}


async def test_aborting_the_conversation_leaves_nothing_queued_to_pick_up(
    engine: AsyncEngine,
) -> None:
    entered, gate = asyncio.Event(), asyncio.Event()
    store = TranscriptStore()
    runner, _step_store, queue = build_runner(engine, waits(entered, gate), store=store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    await submit_text(runner, queue, conversation_id, "先做这个")
    second = await submit_text(runner, queue, conversation_id, "再做那个")
    third = await submit_text(runner, queue, conversation_id, "还有这个")
    await entered.wait()

    await runner.abort_conversation(conversation_id)
    gate.set()
    await drained(queue, conversation_id)
    await runner.shutdown()

    for prompt_id in (second, third):
        row = await queue.get(prompt_id)
        assert row is not None
        assert row.status == "aborted"
        assert row.run_id is None

    assert [prompt_text(turn) for turn in replay(store, conversation_id)] == ["先做这个"]


async def test_aborting_a_queued_prompt_marks_it_aborted(engine: AsyncEngine) -> None:
    entered, gate = asyncio.Event(), asyncio.Event()
    store = TranscriptStore()
    runner, _step_store, queue = build_runner(engine, waits(entered, gate), store=store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    await submit_text(runner, queue, conversation_id, "先做这个")
    second = await submit_text(runner, queue, conversation_id, "再做那个")
    await entered.wait()

    await runner.abort(conversation_id, second)
    row = await queue.get(second)
    assert row is not None
    assert row.status == "aborted"

    gate.set()
    await drained(queue, conversation_id)
    await runner.shutdown()


async def test_an_append_landing_after_the_last_model_request_still_reaches_the_model(
    engine: AsyncEngine,
) -> None:
    seen: list[list[ModelMessage]] = []
    entered, gate = asyncio.Event(), asyncio.Event()
    store = TranscriptStore()
    runner, step_store, queue = build_runner(engine, _records(seen, entered, gate), store=store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    first = await submit_text(runner, queue, conversation_id, "先做这个")
    second = await submit_text(runner, queue, conversation_id, "临时插一句")
    await entered.wait()

    await runner.steer(conversation_id, (second,))
    gate.set()
    await drained(queue, conversation_id)
    await runner.shutdown()

    assert len(seen) == 2
    assert "临时插一句" in texts(seen[1])

    derived = (await TranscriptHistory(step_store, queue).read(conversation_id)).turns
    assert [prompt_text(turn) for turn in derived] == ["先做这个"]
    assert "临时插一句" in [
        getattr(frame, "text", None)
        for turn in derived
        for step in turn.steps
        for frame in step.frames
    ]

    started = await queue.get(first)
    appended = await queue.get(second)
    assert started is not None
    assert appended is not None
    assert appended.run_id == started.run_id
    assert appended.status == "completed"
    assert appended.steered_at is not None


async def test_an_append_is_cancelled_with_the_turn_instead_of_starting_a_new_one(
    engine: AsyncEngine,
) -> None:
    entered, gate = asyncio.Event(), asyncio.Event()
    store = TranscriptStore()
    runner, _step_store, queue = build_runner(engine, waits(entered, gate), store=store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    await submit_text(runner, queue, conversation_id, "先做这个")
    second = await submit_text(runner, queue, conversation_id, "临时插一句")
    await entered.wait()

    await runner.steer(conversation_id, (second,))
    await runner.abort_conversation(conversation_id)
    gate.set()
    await drained(queue, conversation_id)
    await runner.shutdown()

    appended = await queue.get(second)
    assert appended is not None
    assert appended.status == "aborted"

    assert [prompt_text(turn) for turn in replay(store, conversation_id)] == ["先做这个"]


async def test_marking_a_delivered_append_takes_only_rows_still_queued(
    engine: AsyncEngine,
) -> None:
    queue = JobQueue(engine)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"
    now = datetime.now(UTC)
    for prompt_id, said in (
        ("prm_head", "先做这个"),
        ("prm_tail", "临时插一句"),
        ("prm_dropped", "算了不要了"),
    ):
        await queue.submit(
            prompt_id=prompt_id,
            conversation_id=conversation_id,
            agent_id=AGENT_ID,
            owner_user_id=OWNER,
            user_name="logan",
            content=(TextContent(text=said),),
            now=now,
            locked_by=LOCKED_BY,
        )

    (dropped,) = await queue.abort_queued(conversation_id, now=now, only=("prm_dropped",))
    assert dropped.prompt_id == "prm_dropped"

    (moved,) = await queue.mark_steered(
        ("prm_tail", "prm_dropped"), run_id=f"{AGENT_ID}-live", now=now
    )
    assert moved.prompt_id == "prm_tail"
    assert moved.status == "steered"
    assert moved.run_id == f"{AGENT_ID}-live"
    assert moved.steered_at == now
    assert moved.as_entity().status == "running"
    assert (await queue.view(conversation_id)).queued == ()
    still = await queue.get("prm_dropped")
    assert still is not None
    assert (still.status, still.run_id, still.steered_at) == ("aborted", None, None)


async def test_appending_when_nothing_is_running_is_a_conflict(engine: AsyncEngine) -> None:

    store = TranscriptStore()
    runner, _step_store, queue = build_runner(engine, says("好"), store=store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    prompt_id = await submit_text(runner, queue, conversation_id, "先做这个")
    await drained(queue, conversation_id)
    await runner.shutdown()

    with pytest.raises(Conflict):
        await runner.steer(conversation_id, (prompt_id,))


@dataclass
class _SteersAfterRun(AbstractCapability[Any]):
    steer: Callable[[], Awaitable[None]] | None = None

    async def after_run(
        self, ctx: RunContext[Any], *, result: AgentRunResult[Any]
    ) -> AgentRunResult[Any]:
        steer, self.steer = self.steer, None
        if steer is not None:
            await steer()
        return result


async def test_a_steer_landing_after_the_final_drain_runs_as_the_next_turn(
    engine: AsyncEngine,
) -> None:
    entered, gate = asyncio.Event(), asyncio.Event()
    late = _SteersAfterRun()
    step_store = PgStepStore(engine)
    agent = Agent(
        waits(entered, gate),
        name=AGENT_ID,
        output_type=[str, DeferredToolRequests],
        capabilities=[StepPersistence(store=step_store), late],
    )
    store = TranscriptStore()
    runner, _step_store, queue = make_runner(
        engine, agents={AGENT_ID: agent}, step_store=step_store, store=store
    )
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    first = await submit_text(runner, queue, conversation_id, "先做这个")
    second = await submit_text(runner, queue, conversation_id, "临时插一句")
    await entered.wait()
    errors: list[Exception] = []
    seen: list[str] = []

    async def steer() -> None:
        try:
            await runner.steer(conversation_id, (second,))
        except Exception as exc:
            errors.append(exc)
        row = await queue.get(second)
        assert row is not None
        seen.append(row.status)

    late.steer = steer
    gate.set()
    await drained(queue, conversation_id)
    await runner.shutdown()

    assert errors == []
    assert seen == ["queued"]
    started = await queue.get(first)
    appended = await queue.get(second)
    assert started is not None
    assert appended is not None
    assert (started.status, appended.status) == ("completed", "completed")
    assert appended.run_id is not None
    assert appended.run_id != started.run_id
    assert (await queue.prompt_of_runs(conversation_id))[appended.run_id] == second
    derived = (await TranscriptHistory(step_store, queue).read(conversation_id)).turns
    assert [prompt_text(turn) for turn in derived] == ["先做这个", "临时插一句"]


async def test_a_steer_the_crashed_run_never_took_is_not_settled_by_the_resume(
    engine: AsyncEngine,
) -> None:
    entered, gate = asyncio.Event(), asyncio.Event()
    store = TranscriptStore()
    runner, _step_store, queue = build_runner(engine, waits(entered, gate), store=store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    first = await submit_text(runner, queue, conversation_id, "先做这个")
    second = await submit_text(runner, queue, conversation_id, "临时插一句")
    await entered.wait()
    await runner.steer(conversation_id, (second,))
    await expire_lease(engine, conversation_id)

    store2 = TranscriptStore()
    runner2, step_store2, queue2 = build_runner(engine, says("接着写完了"), store=store2)
    await runner2.sweep_once()
    await drained(queue2, conversation_id)
    await runner2.shutdown()

    resumed = await queue.get(first)
    appended = await queue.get(second)
    assert resumed is not None
    assert appended is not None
    assert (resumed.status, resumed.attempt) == ("completed", 1)
    assert appended.status == "completed"
    assert appended.run_id is not None
    assert appended.run_id != resumed.run_id
    assert (await queue.prompt_of_runs(conversation_id))[appended.run_id] == second
    derived = (await TranscriptHistory(step_store2, queue).read(conversation_id)).turns
    assert [prompt_text(turn) for turn in derived] == ["先做这个", "临时插一句"]

    await runner.shutdown()


def _blocks_then_speaks(
    entered: tuple[asyncio.Event, asyncio.Event],
    gates: tuple[asyncio.Event, asyncio.Event],
    after_delivery: Callable[[], Awaitable[None]] | None = None,
) -> FunctionModel:
    asked = 0

    async def stream(
        _messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        nonlocal asked
        asked += 1
        if asked == 1:
            entered[0].set()
            await gates[0].wait()
            yield "第一句"
            return
        yield "补充收到了"
        if after_delivery is not None:
            await after_delivery()
        entered[1].set()
        await gates[1].wait()

    return FunctionModel(stream_function=stream)


async def test_a_steer_stays_queued_until_the_model_takes_it(engine: AsyncEngine) -> None:
    entered = (asyncio.Event(), asyncio.Event())
    gates = (asyncio.Event(), asyncio.Event())
    delivered: list[JobRow | None] = []

    async def look() -> None:
        delivered.append(await queue.get(second))

    store = TranscriptStore()
    runner, _step_store, queue = build_runner(
        engine, _blocks_then_speaks(entered, gates, look), store=store
    )
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    first = await submit_text(runner, queue, conversation_id, "先做这个")
    second = await submit_text(runner, queue, conversation_id, "临时插一句")
    await entered[0].wait()
    await runner.steer(conversation_id, (second,))

    waiting = await queue.get(second)
    assert waiting is not None
    assert (waiting.status, waiting.run_id, waiting.steered_at) == ("queued", None, None)

    gates[0].set()
    await entered[1].wait()
    started = await queue.get(first)
    assert started is not None
    (taken,) = delivered
    assert taken is not None
    assert (taken.status, taken.run_id) == ("steered", started.run_id)
    assert taken.steered_at is not None
    epoch = store.subscribe_view(conversation_id, MAIN_AGENT_ID).epoch
    published = [
        op.prompt
        for batch in store.subscribe_view(
            conversation_id, MAIN_AGENT_ID, since=0, epoch=epoch
        ).batches
        for op in batch.ops
        if isinstance(op, PromptUpsertOp) and op.prompt.prompt_id == second
    ]
    assert [(prompt.status, prompt.steered_at is not None) for prompt in published] == [
        ("queued", False),
        ("running", True),
    ]

    gates[1].set()
    await drained(queue, conversation_id)
    await runner.shutdown()

    settled = await queue.get(second)
    assert settled is not None
    assert (settled.status, settled.run_id) == ("completed", started.run_id)
    assert [
        frame.prompt_ids
        for turn in replay(store, conversation_id)
        for step in turn.steps
        for frame in step.frames
        if isinstance(frame, TextFrame) and frame.role == "user"
    ] == [(second,)]


async def test_stopping_the_turn_drops_a_steer_it_never_took(engine: AsyncEngine) -> None:
    entered, gate = asyncio.Event(), asyncio.Event()
    store = TranscriptStore()
    runner, _step_store, queue = build_runner(engine, waits(entered, gate), store=store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    first = await submit_text(runner, queue, conversation_id, "先做这个")
    second = await submit_text(runner, queue, conversation_id, "临时插一句")
    await entered.wait()
    await runner.steer(conversation_id, (second,))

    await runner.abort(conversation_id, first)
    gate.set()
    await drained(queue, conversation_id)
    await runner.shutdown()

    stopped = await queue.get(first)
    appended = await queue.get(second)
    assert stopped is not None
    assert appended is not None
    assert (stopped.status, appended.status) == ("aborted", "aborted")
    assert (appended.run_id, appended.steered_at) == (None, None)
    assert await queue.prompt_of_runs(conversation_id) == {stopped.run_id: first}
    assert [prompt_text(turn) for turn in replay(store, conversation_id)] == ["先做这个"]


async def test_a_steer_withdrawn_before_the_model_takes_it_stays_aborted(
    engine: AsyncEngine,
) -> None:
    seen: list[list[ModelMessage]] = []
    entered, gate = asyncio.Event(), asyncio.Event()
    store = TranscriptStore()
    runner, _step_store, queue = build_runner(engine, _records(seen, entered, gate), store=store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    first = await submit_text(runner, queue, conversation_id, "先做这个")
    second = await submit_text(runner, queue, conversation_id, "临时插一句")
    await entered.wait()
    await runner.steer(conversation_id, (second,))

    await queue.abort_queued(conversation_id, now=datetime.now(UTC))
    gate.set()
    await drained(queue, conversation_id)
    await runner.shutdown()

    assert "临时插一句" in texts(seen[1])
    started = await queue.get(first)
    appended = await queue.get(second)
    assert started is not None
    assert appended is not None
    assert started.status == "completed"
    assert (appended.status, appended.run_id, appended.steered_at) == ("aborted", None, None)


async def test_stopping_one_steer_waiting_for_delivery_conflicts_like_a_delivered_one(
    engine: AsyncEngine,
) -> None:
    entered = (asyncio.Event(), asyncio.Event())
    gates = (asyncio.Event(), asyncio.Event())
    store = TranscriptStore()
    runner, _step_store, queue = build_runner(
        engine, _blocks_then_speaks(entered, gates), store=store
    )
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    await submit_text(runner, queue, conversation_id, "先做这个")
    second = await submit_text(runner, queue, conversation_id, "临时插一句")
    await entered[0].wait()
    await runner.steer(conversation_id, (second,))

    with pytest.raises(Conflict) as waiting:
        await runner.abort(conversation_id, second)
    pending = await queue.get(second)
    assert pending is not None
    assert pending.status == "queued"

    gates[0].set()
    await entered[1].wait()
    with pytest.raises(Conflict) as taken:
        await runner.abort(conversation_id, second)
    assert str(waiting.value) == str(taken.value)

    gates[1].set()
    await drained(queue, conversation_id)
    await runner.shutdown()

    settled = await queue.get(second)
    assert settled is not None
    assert settled.status == "completed"


async def test_steering_the_same_prompt_twice_enqueues_it_once(engine: AsyncEngine) -> None:

    seen: list[list[ModelMessage]] = []
    entered, gate = asyncio.Event(), asyncio.Event()
    store = TranscriptStore()
    runner, _step_store, queue = build_runner(engine, _records(seen, entered, gate), store=store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    await submit_text(runner, queue, conversation_id, "先做这个")
    second = await submit_text(runner, queue, conversation_id, "临时插一句")
    await entered.wait()
    await runner.steer(conversation_id, (second, second))
    await runner.steer(conversation_id, (second,))
    gate.set()
    await drained(queue, conversation_id)
    await runner.shutdown()

    assert len(seen) == 2
    assert texts(seen[1]).count("临时插一句") == 1
    appended = await queue.get(second)
    assert appended is not None
    assert appended.status == "completed"


async def test_a_run_that_died_mid_tool_still_shows_up_after_a_refresh(
    engine: AsyncEngine,
) -> None:
    def boom() -> str:
        raise RuntimeError("工具炸了")

    store = TranscriptStore()
    runner, step_store, queue = build_runner(engine, calls_tool("boom"), store=store, tools=[boom])
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    prompt_id = await submit_text(runner, queue, conversation_id, "把这三个镜头重新出图")
    await drained(queue, conversation_id)
    await runner.shutdown()

    row = await queue.get(prompt_id)
    assert row is not None
    assert row.status == "failed"

    assert (await step_store.latest_conversation_snapshot(conversation_id=conversation_id)) is None
    interrupted = await step_store.latest_conversation_snapshot(
        conversation_id=conversation_id, include_interrupted=True
    )
    assert interrupted is not None

    derived = (await TranscriptHistory(step_store, queue).read(conversation_id)).turns
    assert [prompt_text(turn) for turn in derived] == ["把这三个镜头重新出图"]
    assert [turn.state for turn in derived] == ["failed"]

    tools = [
        frame
        for turn in derived
        for step in turn.steps
        for frame in step.frames
        if frame.kind == "tool"
    ]
    assert [frame.state for frame in tools] == ["error"]

    assert _skeleton(derived) == _skeleton(replay(store, conversation_id))


async def test_the_close_out_result_tells_the_model_the_call_failed(
    engine: AsyncEngine,
) -> None:
    def boom() -> str:
        raise RuntimeError("工具炸了")

    store = TranscriptStore()
    runner, step_store, queue = build_runner(engine, calls_tool("boom"), store=store, tools=[boom])
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    await submit_text(runner, queue, conversation_id, "先做这个")
    await drained(queue, conversation_id)

    store2 = TranscriptStore()
    runner2, _step_store2, queue2 = build_runner(engine, says("好"), store=store2)
    await submit_text(runner2, queue2, conversation_id, "再做那个")
    await drained(queue2, conversation_id)
    await runner.shutdown()
    await runner2.shutdown()

    snapshot = await step_store.latest_conversation_snapshot(
        conversation_id=conversation_id, include_interrupted=True
    )
    assert snapshot is not None
    returns = [
        part
        for message in snapshot.messages
        for part in getattr(message, "parts", ())
        if isinstance(part, ToolReturnPart)
    ]
    assert [part.outcome for part in returns] == ["failed"]
    assert [part.content for part in returns] == [INTERRUPTED_TOOL_RETURN_CONTENT]


async def test_the_next_turn_after_a_failed_one_does_not_reuse_its_ordinal(
    engine: AsyncEngine,
) -> None:
    def boom() -> str:
        raise RuntimeError("工具炸了")

    store = TranscriptStore()
    runner, step_store, queue = build_runner(engine, calls_tool("boom"), store=store, tools=[boom])
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    await submit_text(runner, queue, conversation_id, "先做这个")
    await drained(queue, conversation_id)

    store2 = TranscriptStore()
    runner2, _step_store2, queue2 = build_runner(engine, says("好"), store=store2)
    await submit_text(runner2, queue2, conversation_id, "再做那个")
    await drained(queue2, conversation_id)
    await runner.shutdown()
    await runner2.shutdown()

    derived = (await TranscriptHistory(step_store, queue).read(conversation_id)).turns
    assert [(turn.turn_id, turn.ordinal) for turn in derived] == [("t1", 1), ("t2", 2)]
    assert [turn.state for turn in derived] == ["failed", "completed"]


async def test_shutdown_leaves_an_append_the_run_never_read_in_the_queue(
    engine: AsyncEngine,
) -> None:
    entered, gate = asyncio.Event(), asyncio.Event()
    store = TranscriptStore()
    runner, _step_store, queue = build_runner(engine, waits(entered, gate), store=store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    await submit_text(runner, queue, conversation_id, "先做这个")
    second = await submit_text(runner, queue, conversation_id, "临时插一句")
    await entered.wait()

    await runner.steer(conversation_id, (second,))
    await runner.shutdown()

    appended = await queue.get(second)
    assert appended is not None
    assert appended.status == "queued"
    assert appended.run_id is None


async def test_aborting_a_prompt_from_another_conversation_is_not_found(
    engine: AsyncEngine,
) -> None:

    store = TranscriptStore()
    runner, _step_store, queue = build_runner(engine, says("好"), store=store)
    prompt_id = await submit_text(runner, queue, "c-owner", "跑起来")
    second = await submit_text(runner, queue, "c-owner", "排着")

    for target in (prompt_id, second):
        with pytest.raises(NotFound):
            await runner.abort("c-someone-else", target)
    queued = await queue.get(second)
    assert queued is not None
    assert queued.status == "queued"

    await runner.shutdown()


def _waits_then_calls(name: str, entered: asyncio.Event, gate: asyncio.Event) -> FunctionModel:
    asked = 0

    async def stream(
        _messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        nonlocal asked
        asked += 1
        if asked == 1:
            entered.set()
            await gate.wait()
            yield {0: DeltaToolCall(name=name, json_args="{}", tool_call_id="call_1")}
        else:
            yield "改完了"

    return FunctionModel(stream_function=stream)


async def test_an_append_arriving_as_the_run_would_park_on_approval_is_not_lost(
    engine: AsyncEngine,
) -> None:
    entered, gate = asyncio.Event(), asyncio.Event()
    store = TranscriptStore()
    runner, step_store, queue = build_runner(
        engine,
        _waits_then_calls("write_file", entered, gate),
        store=store,
        tools=[Tool(wrote, name="write_file", requires_approval=True)],
    )
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    first = await submit_text(runner, queue, conversation_id, "把这个文件改掉")
    second = await submit_text(runner, queue, conversation_id, "临时插一句")
    await entered.wait()
    await runner.steer(conversation_id, (second,))
    gate.set()
    await drained(queue, conversation_id)
    await runner.shutdown()

    settled = await queue.get(first)
    appended = await queue.get(second)
    assert settled is not None
    assert appended is not None
    assert settled.status == "completed"
    assert (appended.status, appended.run_id) == ("completed", settled.run_id)

    derived = (await TranscriptHistory(step_store, queue).read(conversation_id)).turns
    assert [(turn.turn_id, turn.state, prompt_text(turn)) for turn in derived] == [
        ("t1", "completed", "把这个文件改掉")
    ]
    snapshot = await step_store.latest_conversation_snapshot(
        conversation_id=conversation_id, include_interrupted=True
    )
    assert snapshot is not None
    assert "临时插一句" in texts(list(snapshot.messages))
    assert [card.state for card in tool_cards(derived)] == ["error"]
    assert _skeleton(replay(store, conversation_id)) == _skeleton(derived)


async def test_a_tool_needing_approval_ends_the_run_and_parks_the_prompt(
    engine: AsyncEngine,
) -> None:
    store = TranscriptStore()
    runner, step_store, queue = approval_runner(engine, store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    prompt_id = await submit_text(runner, queue, conversation_id, "把这个文件改掉")
    row = await awaits(queue, prompt_id)

    assert row.as_entity().status == "running"
    assert (row.locked_by, row.heartbeat_at) == (None, None)
    assert row.run_id is not None

    assert (await step_store.latest_conversation_snapshot(conversation_id=conversation_id)) is None
    parked = await step_store.latest_conversation_snapshot(
        conversation_id=conversation_id, include_interrupted=True
    )
    assert parked is not None
    assert run_ids_from_messages(parked.messages) == (row.run_id,)

    live = replay(store, conversation_id)
    assert [turn.state for turn in live] == ["running"]
    assert [step.state for step in live[0].steps] == ["completed"]
    card = tool_cards(live)[0]
    assert (card.state, card.approval_id) == ("running", "apr_call_1")
    assert [
        item.interaction_id for item in store.pending_interactions(conversation_id, MAIN_AGENT_ID)
    ] == ["apr_call_1"]

    page = await TranscriptService(
        store=TranscriptStore(),
        history=TranscriptHistory(step_store, queue),
        queue=queue,
        runner=runner,
    ).page(conversation_id, runtime_agent_id=AGENT_ID)
    assert [turn.state for turn in page.items] == ["running"]
    restored = tool_cards(page.items)[0]
    assert (restored.state, restored.approval_id) == ("running", "apr_call_1")
    assert page.pending_interactions == ("apr_call_1",)
    assert page.meta.activity == "turn"

    assert await queue.activities((conversation_id,)) == {
        conversation_id: ActivityState(busy=True, pending_interaction="approval")
    }

    await runner.shutdown()


async def test_every_run_start_is_reported_once_with_its_run_id(engine: AsyncEngine) -> None:
    started: list[tuple[str, str]] = []

    async def note(row: JobRow, run_id: str) -> None:
        started.append((row.prompt_id, run_id))

    store = TranscriptStore()
    runner, _, queue = approval_runner(engine, store, on_run_started=note)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    prompt_id = await submit_text(runner, queue, conversation_id, "把这个文件改掉")
    await awaits(queue, prompt_id)
    await runner.approve(conversation_id, "apr_call_1", approved=True)
    await drained(queue, conversation_id)
    await runner.shutdown()

    assert [prompt for prompt, _ in started] == [prompt_id, prompt_id]
    assert sorted(run for _, run in started) == sorted(await queue.prompt_of_runs(conversation_id))


async def test_a_failing_run_start_hook_does_not_stop_the_run(engine: AsyncEngine) -> None:
    async def explode(_row: JobRow, _run_id: str) -> None:
        raise RuntimeError("对话行不见了")

    store = TranscriptStore()
    runner, step_store, queue = build_runner(
        engine, says("写好了"), store=store, on_run_started=explode
    )
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    prompt_id = await submit_text(runner, queue, conversation_id, "写三个镜头")
    await drained(queue, conversation_id)
    await runner.shutdown()

    row = await queue.get(prompt_id)
    assert row is not None
    assert row.status == "completed"
    derived = (await TranscriptHistory(step_store, queue).read(conversation_id)).turns
    assert derived[0].steps[0].frames[0].text == "写好了"  # pyright: ignore[reportAttributeAccessIssue]


async def test_a_turn_start_action_runs_while_the_turn_is_still_running(
    engine: AsyncEngine,
) -> None:
    entered, gate = asyncio.Event(), asyncio.Event()
    named = asyncio.Event()
    started: list[str] = []

    async def name(row: JobRow) -> None:
        started.append(row.prompt_id)
        named.set()

    store = TranscriptStore()
    runner, _, queue = build_runner(engine, waits(entered, gate), store=store, on_turn_started=name)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    prompt_id = await submit_text(runner, queue, conversation_id, "做一条春季新款视频")
    await asyncio.wait_for(asyncio.gather(entered.wait(), named.wait()), timeout=5)
    row = await queue.get(prompt_id)
    assert row is not None
    assert row.status == "running"
    assert started == [prompt_id]

    gate.set()
    await drained(queue, conversation_id)
    await runner.shutdown()
    assert started == [prompt_id]


async def test_a_slow_turn_start_action_neither_holds_up_the_turn_nor_outlives_shutdown(
    engine: AsyncEngine,
) -> None:
    never = asyncio.Event()
    entered = asyncio.Event()
    cancelled = asyncio.Event()

    async def hang(_row: JobRow) -> None:
        entered.set()
        try:
            await never.wait()
        except asyncio.CancelledError:
            cancelled.set()
            raise

    store = TranscriptStore()
    runner, _, queue = build_runner(engine, says("写好了"), store=store, on_turn_started=hang)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    prompt_id = await submit_text(runner, queue, conversation_id, "写三个镜头")
    await drained(queue, conversation_id)
    row = await queue.get(prompt_id)
    assert row is not None
    assert row.status == "completed"
    assert entered.is_set()
    assert not cancelled.is_set()

    await asyncio.wait_for(runner.shutdown(), timeout=5)
    assert cancelled.is_set()


async def test_a_failing_turn_start_action_does_not_stop_the_turn(engine: AsyncEngine) -> None:
    async def explode(_row: JobRow) -> None:
        raise RuntimeError("标题模型不可用")

    store = TranscriptStore()
    runner, step_store, queue = build_runner(
        engine, says("写好了"), store=store, on_turn_started=explode
    )
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    prompt_id = await submit_text(runner, queue, conversation_id, "写三个镜头")
    await drained(queue, conversation_id)
    await runner.shutdown()

    row = await queue.get(prompt_id)
    assert row is not None
    assert row.status == "completed"
    derived = (await TranscriptHistory(step_store, queue).read(conversation_id)).turns
    assert derived[0].steps[0].frames[0].text == "写好了"  # pyright: ignore[reportAttributeAccessIssue]


async def test_an_approval_continuation_does_not_start_the_turn_again(engine: AsyncEngine) -> None:
    started: list[str] = []

    async def note(row: JobRow) -> None:
        started.append(row.prompt_id)

    store = TranscriptStore()
    runner, _, queue = approval_runner(engine, store, on_turn_started=note)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    prompt_id = await submit_text(runner, queue, conversation_id, "把这个文件改掉")
    await awaits(queue, prompt_id)
    await runner.approve(conversation_id, "apr_call_1", approved=True)
    await drained(queue, conversation_id)
    await runner.shutdown()

    assert started == [prompt_id]
    assert len(await queue.prompt_of_runs(conversation_id)) == 2


async def test_the_run_resumes_only_once_every_approval_is_answered(
    engine: AsyncEngine,
) -> None:
    store = TranscriptStore()
    runner, step_store, queue = approval_runner(engine, store, calls=2)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    prompt_id = await submit_text(runner, queue, conversation_id, "把这两个文件改掉")
    await awaits(queue, prompt_id)

    await runner.approve(conversation_id, "apr_call_1", approved=True)
    half = await queue.get(prompt_id)
    assert half is not None
    assert (half.status, half.decisions) == ("awaiting", {"call_1": True})

    await runner.approve(conversation_id, "apr_call_1", approved=True)
    with pytest.raises(Conflict):
        await runner.approve(conversation_id, "apr_call_1", approved=False)
    with pytest.raises(NotFound):
        await runner.approve(conversation_id, "apr_nobody", approved=True)

    await runner.approve(conversation_id, "apr_call_2", approved=True)
    await drained(queue, conversation_id)
    await runner.shutdown()

    row = await queue.get(prompt_id)
    assert row is not None
    assert (row.status, row.decisions) == ("completed", {"call_1": True, "call_2": True})
    derived = (await TranscriptHistory(step_store, queue).read(conversation_id)).turns
    assert [card.state for card in tool_cards(derived)] == ["done", "done"]
    assert _skeleton(replay(store, conversation_id)) == _skeleton(derived)


async def test_a_conversation_waiting_for_approval_takes_no_steering_and_queues_the_next(
    engine: AsyncEngine,
) -> None:
    store = TranscriptStore()
    runner, step_store, queue = approval_runner(engine, store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    first = await submit_text(runner, queue, conversation_id, "把这个文件改掉")
    await awaits(queue, first)
    second = await submit_text(runner, queue, conversation_id, "再说点别的")

    queued = await queue.get(second)
    assert queued is not None
    assert queued.status == "queued"
    with pytest.raises(Conflict):
        await runner.steer(conversation_id, (second,))

    await runner.abort(conversation_id, first)
    aborted = await queue.get(first)
    assert aborted is not None
    assert aborted.status == "aborted"

    await drained(queue, conversation_id)
    await runner.shutdown()

    replayed = replay(store, conversation_id)
    assert replayed[0].state == "cancelled"
    assert replayed[0].duration_ms is not None
    assert [card.state for card in tool_cards(replayed[:1])] == ["error"]
    assert store.pending_interactions(conversation_id, MAIN_AGENT_ID) == ()

    following = await queue.get(second)
    assert following is not None
    assert following.status == "completed"
    derived = (await TranscriptHistory(step_store, queue).read(conversation_id)).turns
    assert [(turn.turn_id, turn.state) for turn in derived] == [
        ("t1", "cancelled"),
        ("t2", "completed"),
    ]


async def test_stopping_the_conversation_also_drops_the_one_waiting_for_approval(
    engine: AsyncEngine,
) -> None:
    store = TranscriptStore()
    runner, _step_store, queue = approval_runner(engine, store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    prompt_id = await submit_text(runner, queue, conversation_id, "把这个文件改掉")
    parked = await awaits(queue, prompt_id)
    appended = await submit_text(runner, queue, conversation_id, "临时插一句")
    assert parked.run_id is not None
    await queue.mark_steered((appended,), run_id=parked.run_id, now=datetime.now(UTC))

    await runner.abort_conversation(conversation_id)
    await runner.shutdown()

    row = await queue.get(prompt_id)
    assert row is not None
    assert row.status == "aborted"
    child = await queue.get(appended)
    assert child is not None
    assert child.status == "aborted"
    assert [turn.state for turn in replay(store, conversation_id)] == ["cancelled"]


LEGACY_IMAGE = (
    TextContent(text="照这张图"),
    ImageContent(source=AttachmentSource(kind="url", url="https://cdn.test/legacy.jpg")),
)


def _prompt_texts(messages: list[ModelMessage]) -> list[str]:
    found: list[str] = []
    for message in messages:
        for part in getattr(message, "parts", ()):
            if not isinstance(part, UserPromptPart):
                continue
            items = [part.content] if isinstance(part.content, str) else list(part.content)
            found.extend(item for item in items if isinstance(item, str))
    return found


async def test_a_queued_legacy_image_fails_its_run_and_the_queue_moves_on(
    engine: AsyncEngine,
) -> None:
    seen: list[list[ModelMessage]] = []

    async def stream(
        messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        seen.append(list(messages))
        yield "好"

    store = TranscriptStore()
    runner, _step_store, queue = build_runner(
        engine, FunctionModel(stream_function=stream), store=store
    )
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    with capture_logs() as logs:
        legacy = await submit_text(runner, queue, conversation_id, "", content=LEGACY_IMAGE)
        following = await submit_text(runner, queue, conversation_id, "接着做")
        await drained(queue, conversation_id)
    await runner.shutdown()

    failed = await queue.get(legacy)
    assert failed is not None
    assert failed.status == "failed"
    done = await queue.get(following)
    assert done is not None
    assert done.status == "completed"
    assert len(seen) == 1, "旧消息没有发给模型"
    assert "接着做" in _prompt_texts(seen[0])
    assert "照这张图" not in _prompt_texts(seen[0])
    assert [
        entry["log_level"]
        for entry in logs
        if entry["event"] == "这次运行没跑完" and entry.get("prompt_id") == legacy
    ] == ["error"]


async def test_steering_a_legacy_image_is_refused_and_the_batch_stays_queued(
    engine: AsyncEngine,
) -> None:
    entered, gate = asyncio.Event(), asyncio.Event()
    store = TranscriptStore()
    runner, _step_store, queue = build_runner(engine, waits(entered, gate), store=store)
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"

    first = await submit_text(runner, queue, conversation_id, "先做这个")
    plain = await submit_text(runner, queue, conversation_id, "顺便改个标题")
    legacy = await submit_text(runner, queue, conversation_id, "", content=LEGACY_IMAGE)
    await entered.wait()

    with pytest.raises(ValidationFailed, match=r"cdn\.test/legacy\.jpg"):
        await runner.steer(conversation_id, (plain, legacy))

    for prompt_id in (plain, legacy):
        row = await queue.get(prompt_id)
        assert row is not None
        assert (row.status, row.run_id, row.steered_at) == ("queued", None, None)

    gate.set()
    await drained(queue, conversation_id)
    await runner.shutdown()

    started = await queue.get(first)
    after = await queue.get(plain)
    assert started is not None and after is not None
    assert after.run_id != started.run_id, "没插进去的那条收尾后按新一轮跑"
