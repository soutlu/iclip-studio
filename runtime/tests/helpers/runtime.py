from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import AsyncIterator, Mapping, Sequence
from datetime import UTC, datetime
from typing import Any

from pydantic_ai import Agent, Tool
from pydantic_ai.capabilities import AgentCapability
from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai.models import Model
from pydantic_ai.models.function import AgentInfo, DeltaToolCall, DeltaToolCalls, FunctionModel
from pydantic_ai.tools import DeferredToolRequests
from pydantic_ai_harness.step_persistence import (
    ContinuableSnapshot,
    RunRecord,
    StepEvent,
    StepPersistence,
)
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from cue.errors import AgentUnavailable
from cue.harness.agents import (
    DELEGATE_TOOL,
    SubAgentSlot,
    build_agent,
    build_subagents,
    profile_metadata,
    subagent_profile,
)
from cue.harness.jobs import JobQueue, JobRow
from cue.harness.step_store_pg import PgStepStore
from cue.harness.transcript.history import TranscriptHistory
from cue.harness.transcript.runner import (
    ConversationRunner,
    DepsFor,
    RunAgent,
    RunStarted,
    TurnStarted,
)
from cue.harness.transcript.store import TranscriptStore
from cue.harness.transcript.subagents import SubAgentMirror
from cue.harness.usage_ledger import UsageLedger
from cue.transcript.display import ToolDisplayRegistry
from cue.transcript.ops import (
    MAIN_AGENT_ID,
    PromptContent,
    StepUsage,
    TextContent,
    ToolFrame,
    TranscriptTurn,
)

AGENT_ID = "storyboard"
MAX_CONTEXT_TOKENS = 4096
OWNER = uuid.UUID("11111111-2222-3333-4444-555555555555")
LOCKED_BY = "w-test"
DEAD = "w-dead"


class _DiscardingUsageStore:
    async def add(self, *, conversation_id: str, model_name: str, usage: StepUsage) -> None:
        return None


def discarding_usage_ledger() -> UsageLedger:
    return UsageLedger(store=_DiscardingUsageStore(), conversation_of=lambda _deps: "conversation")


def new_conversation_id() -> str:
    return f"c-{uuid.uuid4().hex[:8]}"


def says(*replies: str) -> FunctionModel:
    said = 0

    async def stream(
        _messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        nonlocal said
        yield replies[min(said, len(replies) - 1)]
        said += 1

    return FunctionModel(stream_function=stream)


def delegates(*calls: tuple[str, str]) -> FunctionModel:
    async def stream(
        messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        if len(messages) == 1:
            yield {
                index: DeltaToolCall(
                    name=DELEGATE_TOOL,
                    json_args=json.dumps(
                        {"agent_name": agent_name, "task": task}, ensure_ascii=False
                    ),
                    tool_call_id=f"call_d{index + 1}",
                )
                for index, (agent_name, task) in enumerate(calls)
            }
        else:
            yield "都写完了"

    return FunctionModel(stream_function=stream)


def waits(entered: asyncio.Event, gate: asyncio.Event) -> FunctionModel:
    async def stream(
        _messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        entered.set()
        await gate.wait()
        yield "跑完了"

    return FunctionModel(stream_function=stream)


def calls_tool(name: str) -> FunctionModel:
    async def stream(
        _messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        yield {0: DeltaToolCall(name=name, json_args="{}", tool_call_id="call_boom")}

    return FunctionModel(stream_function=stream)


def calls_then_says(name: str, reply: str, *, calls: int = 1) -> FunctionModel:
    asked = 0

    async def stream(
        _messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        nonlocal asked
        asked += 1
        if asked == 1:
            yield {
                index: DeltaToolCall(name=name, json_args="{}", tool_call_id=f"call_{index + 1}")
                for index in range(calls)
            }
        else:
            yield reply

    return FunctionModel(stream_function=stream)


def wrote() -> str:
    return "写好了"


def texts(messages: list[ModelMessage]) -> list[str]:
    return [
        part.content
        for message in messages
        for part in getattr(message, "parts", ())
        if isinstance(part, UserPromptPart) and isinstance(part.content, str)
    ]


class FixedAgents:
    def __init__(
        self, agents: Mapping[str, Agent[Any, Any]], context_limits: Mapping[str, int]
    ) -> None:
        self._agents = dict(agents)
        self._limits = dict(context_limits)

    async def for_conversation(self, conversation_id: str, agent_id: str) -> RunAgent:
        agent = self._agents.get(agent_id)
        if agent is None:
            raise AgentUnavailable(f"没有登记 agent {agent_id}")
        return RunAgent(agent=agent, context_window=self._limits.get(agent_id))


def delegating_agent(
    *,
    parent: Model,
    children: Mapping[str, Model],
    step_store: PgStepStore,
    live: TranscriptStore,
    display: ToolDisplayRegistry = ToolDisplayRegistry.EMPTY,
) -> Agent[Any, Any]:
    ledger = discarding_usage_ledger()
    profiles = {name: subagent_profile(name, model) for name, model in children.items()}
    slots = [
        SubAgentSlot(
            name=name,
            description="",
            agent=build_agent(
                name=name,
                model=model,
                instructions="",
                plugins=(),
                plugin_types=(),
                step_store=step_store,
                usage_ledger=ledger,
                run_metadata=profile_metadata(profiles[name]),
                accepts_deferred=False,
            ),
        )
        for name, model in children.items()
    ]
    return build_agent(
        name=AGENT_ID,
        model=parent,
        instructions="",
        plugins=(),
        plugin_types=(),
        step_store=step_store,
        usage_ledger=ledger,
        run_metadata={},
        accepts_deferred=True,
        extra=[
            build_subagents(
                slots, mirror=SubAgentMirror(live=live, display=display, profiles=profiles)
            )
        ],
    )


def make_runner(
    engine: AsyncEngine,
    *,
    agents: Mapping[str, Agent[Any, Any]],
    step_store: PgStepStore,
    store: TranscriptStore,
    display: ToolDisplayRegistry = ToolDisplayRegistry.EMPTY,
    max_attempts: int = 2,
    context_limits: Mapping[str, int] | None = None,
    on_run_started: RunStarted | None = None,
    on_turn_started: TurnStarted | None = None,
    deps_for: DepsFor | None = None,
    compaction_keep_messages: int | None = None,
) -> tuple[ConversationRunner, PgStepStore, JobQueue]:
    queue = JobQueue(engine)

    async def no_deps(_row: Any) -> object:
        return None

    compaction: dict[str, int] = (
        {}
        if compaction_keep_messages is None
        else {"compaction_keep_messages": compaction_keep_messages}
    )
    runner = ConversationRunner(
        agents=FixedAgents(
            agents,
            {AGENT_ID: MAX_CONTEXT_TOKENS} if context_limits is None else context_limits,
        ),
        store=store,
        queue=queue,
        snapshots=step_store,
        history=TranscriptHistory(step_store, queue, display, DELEGATE_TOOL),
        deps_for=no_deps if deps_for is None else deps_for,
        heartbeat_seconds=10,
        lease_seconds=30,
        sweep_seconds=15,
        max_attempts=max_attempts,
        on_run_started=on_run_started,
        on_turn_started=on_turn_started,
        display=display,
        **compaction,
    )
    return runner, step_store, queue


def build_runner(
    engine: AsyncEngine,
    model: FunctionModel,
    *,
    store: TranscriptStore,
    tools: Sequence[Any] = (),
    max_attempts: int = 2,
    display: ToolDisplayRegistry = ToolDisplayRegistry.EMPTY,
    context_limits: Mapping[str, int] | None = None,
    on_run_started: RunStarted | None = None,
    on_turn_started: TurnStarted | None = None,
    capabilities: Sequence[AgentCapability[Any]] = (),
    deps_for: DepsFor | None = None,
    compaction_keep_messages: int | None = None,
) -> tuple[ConversationRunner, PgStepStore, JobQueue]:
    step_store = PgStepStore(engine)
    agent = Agent(
        model,
        name=AGENT_ID,
        tools=list(tools),
        output_type=[str, DeferredToolRequests],
        capabilities=[StepPersistence(store=step_store), *capabilities],
    )
    return make_runner(
        engine,
        agents={AGENT_ID: agent},
        step_store=step_store,
        store=store,
        display=display,
        max_attempts=max_attempts,
        context_limits=context_limits,
        on_run_started=on_run_started,
        on_turn_started=on_turn_started,
        deps_for=deps_for,
        compaction_keep_messages=compaction_keep_messages,
    )


def approval_runner(
    engine: AsyncEngine,
    store: TranscriptStore,
    *,
    reply: str = "改完了",
    calls: int = 1,
    on_run_started: RunStarted | None = None,
    on_turn_started: TurnStarted | None = None,
) -> tuple[ConversationRunner, PgStepStore, JobQueue]:
    return build_runner(
        engine,
        calls_then_says("write_file", reply, calls=calls),
        store=store,
        tools=[Tool(wrote, name="write_file", requires_approval=True)],
        on_run_started=on_run_started,
        on_turn_started=on_turn_started,
    )


async def submit_text(
    runner: ConversationRunner,
    queue: JobQueue,
    conversation_id: str,
    text_: str,
    *,
    content: tuple[PromptContent, ...] | None = None,
) -> str:
    prompt_id = f"prm_{uuid.uuid4().hex[:8]}"
    row, _ = await queue.submit(
        prompt_id=prompt_id,
        conversation_id=conversation_id,
        agent_id=AGENT_ID,
        owner_user_id=OWNER,
        user_name="logan",
        content=(TextContent(text=text_),) if content is None else content,
        now=datetime.now(UTC),
        locked_by=runner.locked_by,
    )
    await runner.submit(row)
    return prompt_id


async def expire_lease(engine: AsyncEngine, conversation_id: str, *, attempt: int = 0) -> None:
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "UPDATE agent_runtime.agent_jobs "
                "SET heartbeat_at = now() - INTERVAL '1 hour', attempt = :attempt "
                "WHERE conversation_id = :conversation_id AND status = 'running'"
            ),
            {"conversation_id": conversation_id, "attempt": attempt},
        )


def first_run_messages(run_id: str) -> list[ModelMessage]:
    started = datetime(2026, 9, 1, 10, 0, tzinfo=UTC)
    return [
        ModelRequest(
            parts=[UserPromptPart(content="把这三个镜头出图")], run_id=run_id, timestamp=started
        ),
        ModelResponse(
            parts=[ToolCallPart(tool_name="draft", args="{}", tool_call_id="call_1")],
            run_id=run_id,
            timestamp=started,
        ),
        ModelRequest(
            parts=[ToolReturnPart(tool_name="draft", content="出好了", tool_call_id="call_1")],
            run_id=run_id,
            timestamp=started,
        ),
    ]


async def plant_interrupted(
    engine: AsyncEngine,
    step_store: PgStepStore,
    queue: JobQueue,
    conversation_id: str,
    *,
    run_id: str,
    messages: list[ModelMessage] | None = None,
    attempt: int = 0,
) -> str:
    prompt_id = f"prm_{uuid.uuid4().hex[:8]}"
    await queue.submit(
        prompt_id=prompt_id,
        conversation_id=conversation_id,
        agent_id=AGENT_ID,
        owner_user_id=OWNER,
        user_name="logan",
        content=(TextContent(text="把这三个镜头出图"),),
        now=datetime.now(UTC),
        locked_by=DEAD,
    )
    await queue.attach_run(prompt_id, run_id, locked_by=DEAD, attempt=0)
    if messages is not None:
        await step_store.register_run(RunRecord(run_id=run_id, conversation_id=conversation_id))
        await step_store.append_event(
            StepEvent(
                run_id=run_id, kind="run_started", step_index=0, conversation_id=conversation_id
            )
        )
        await step_store.save_snapshot(
            ContinuableSnapshot(
                run_id=run_id, step_index=1, messages=messages, conversation_id=conversation_id
            )
        )
    await expire_lease(engine, conversation_id, attempt=attempt)
    return prompt_id


async def drained(queue: JobQueue, conversation_id: str, *, tries: int = 200) -> None:
    for _ in range(tries):
        view = await queue.view(conversation_id)
        if view.active is None and not view.queued:
            return
        await asyncio.sleep(0.02)
    raise AssertionError("队列没排空")


async def awaits(queue: JobQueue, prompt_id: str, *, tries: int = 200) -> JobRow:
    for _ in range(tries):
        row = await queue.get(prompt_id)
        if row is not None and row.status == "awaiting":
            return row
        await asyncio.sleep(0.02)
    raise AssertionError("这条 prompt 没停在审批上")


def prompt_text(turn: TranscriptTurn) -> str:
    return "".join(part.text for part in turn.content if part.type == "text")


def replay_journal(
    store: TranscriptStore, conversation_id: str, agent_id: str = MAIN_AGENT_ID
) -> TranscriptStore:
    replayed = TranscriptStore()
    epoch = store.subscribe_view(conversation_id, agent_id).epoch
    for batch in store.subscribe_view(conversation_id, agent_id, since=0, epoch=epoch).batches:
        replayed.append(conversation_id, agent_id, batch.ops)
    return replayed


def replay(
    store: TranscriptStore, conversation_id: str, agent_id: str = MAIN_AGENT_ID
) -> tuple[TranscriptTurn, ...]:
    return (
        replay_journal(store, conversation_id, agent_id)
        .subscribe_view(conversation_id, agent_id)
        .live_turns
    )


def tool_cards(turns: Sequence[TranscriptTurn]) -> list[ToolFrame]:
    return [
        frame
        for turn in turns
        for step in turn.steps
        for frame in step.frames
        if isinstance(frame, ToolFrame)
    ]


__all__ = [
    "AGENT_ID",
    "DEAD",
    "LOCKED_BY",
    "MAX_CONTEXT_TOKENS",
    "OWNER",
    "FixedAgents",
    "approval_runner",
    "awaits",
    "build_runner",
    "calls_then_says",
    "calls_tool",
    "delegating_agent",
    "drained",
    "expire_lease",
    "first_run_messages",
    "make_runner",
    "new_conversation_id",
    "plant_interrupted",
    "prompt_text",
    "replay",
    "replay_journal",
    "says",
    "submit_text",
    "texts",
    "tool_cards",
    "waits",
    "wrote",
]
