from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Protocol, cast

from pydantic_ai.messages import ModelMessage, ModelResponse, ToolCallPart
from pydantic_ai_harness.compaction import estimate_context_tokens
from pydantic_ai_harness.step_persistence import (
    ContinuableSnapshot,
    RunRecord,
    StepEvent,
    StepStore,
    ToolEffectRecord,
)

from agent_runtime.harness.agents import SubAgentProfile
from agent_runtime.harness.job_status import JobStatus
from agent_runtime.harness.transcript.from_messages import (
    ChildRun,
    SteeredPrompt,
    TurnState,
    approvals_from_messages,
    drop_last_turn,
    keep_turns,
    run_error_from_events,
    run_ids_from_messages,
    run_state_from_events,
    tasks_from_messages,
    turn_run_ids,
    turns_from_messages,
)
from agent_runtime.transcript.display import ToolDisplayRegistry
from agent_runtime.transcript.ops import (
    AgentDescriptor,
    Interaction,
    TranscriptTask,
    TranscriptTurn,
    agents_from_tasks,
)


class ConversationSnapshots(StepStore, Protocol):
    async def latest_conversation_snapshot(
        self, *, conversation_id: str, include_interrupted: bool = False
    ) -> ContinuableSnapshot | None: ...

    async def list_events_for_runs(
        self, run_ids: Sequence[str]
    ) -> Mapping[str, list[StepEvent]]: ...

    async def list_child_runs(
        self, parent_run_ids: Sequence[str]
    ) -> Mapping[str, list[RunRecord]]: ...

    async def get_tool_effects(
        self, keys: Sequence[tuple[str, str]]
    ) -> Mapping[tuple[str, str], ToolEffectRecord]: ...


class PromptRunsSource(Protocol):
    async def prompt_of_runs(self, conversation_id: str) -> dict[str, str]: ...

    async def prompt_status_of_runs(self, conversation_id: str) -> dict[str, JobStatus]: ...

    async def steered_prompts(self, conversation_id: str) -> tuple[SteeredPrompt, ...]: ...


@dataclass(frozen=True, slots=True)
class TranscriptHistoryView:
    turns: tuple[TranscriptTurn, ...]
    context_tokens: int | None
    interactions: tuple[Interaction, ...] = ()
    tasks: tuple[TranscriptTask, ...] = ()
    agents: tuple[AgentDescriptor, ...] = ()


@dataclass(frozen=True, slots=True)
class TranscriptHistory:
    store: ConversationSnapshots
    prompt_runs: PromptRunsSource
    display: ToolDisplayRegistry = ToolDisplayRegistry.EMPTY
    delegate_tool: str | None = None

    async def read(self, conversation_id: str) -> TranscriptHistoryView:
        snapshot = await self.store.latest_conversation_snapshot(
            conversation_id=conversation_id, include_interrupted=True
        )
        if snapshot is None:
            return TranscriptHistoryView(turns=(), context_tokens=None)
        run_ids = run_ids_from_messages(snapshot.messages)
        events_of = await self.store.list_events_for_runs(run_ids)
        states = _run_states(run_ids, events_of)
        errors: dict[str, str | None] = {}
        for run_id in run_ids:
            errors[run_id] = (
                None if states[run_id] == "cancelled" else run_error_from_events(events_of[run_id])
            )
        of_run = await self.prompt_runs.prompt_of_runs(conversation_id)
        status_of_run = await self.prompt_runs.prompt_status_of_runs(conversation_id)
        steered = await self.prompt_runs.steered_prompts(conversation_id)
        subagent_of_call, tasks = await self._delegations(snapshot.messages, run_ids, states)
        return TranscriptHistoryView(
            turns=turns_from_messages(
                snapshot.messages,
                turn_states=states,
                turn_errors=errors,
                prompt_of_run=of_run,
                prompt_status_of_run=status_of_run,
                subagent_of_call=subagent_of_call,
                steered=steered,
                display=self.display,
            ),
            context_tokens=estimate_context_tokens(snapshot.messages),
            interactions=approvals_from_messages(
                snapshot.messages,
                turn_states=states,
                prompt_of_run=of_run,
                prompt_status_of_run=status_of_run,
            ),
            tasks=tasks,
            agents=agents_from_tasks(tasks),
        )

    async def read_tasks(self, conversation_id: str) -> tuple[TranscriptTask, ...]:
        snapshot = await self.store.latest_conversation_snapshot(
            conversation_id=conversation_id, include_interrupted=True
        )
        if snapshot is None:
            return ()
        run_ids = run_ids_from_messages(snapshot.messages)
        states = _run_states(run_ids, await self.store.list_events_for_runs(run_ids))
        _, tasks = await self._delegations(snapshot.messages, run_ids, states)
        return tasks

    async def _delegations(
        self,
        messages: Sequence[ModelMessage],
        run_ids: Sequence[str],
        run_states: Mapping[str, TurnState],
    ) -> tuple[dict[str, str], tuple[TranscriptTask, ...]]:
        subagent_of_call = await self._subagent_of_call(messages)
        tasks = tasks_from_messages(
            messages,
            subagent_of_call=subagent_of_call,
            child_runs=await self._child_runs(run_ids, run_states),
            run_states=run_states,
            display=self.display,
        )
        return subagent_of_call, tasks

    async def read_child(self, child_run_id: str) -> TranscriptHistoryView:
        snapshot = await self.store.latest_snapshot(run_id=child_run_id, include_interrupted=True)
        if snapshot is None:
            return TranscriptHistoryView(turns=(), context_tokens=None)
        events = await self.store.list_events(run_id=child_run_id)
        state = run_state_from_events(events)
        if not _ended(events):
            record = await self.store.get_run(run_id=child_run_id)
            parent_run_id = None if record is None else record.parent_run_id
            if parent_run_id is not None and await self._cancelled(parent_run_id):
                state = "cancelled"
        return TranscriptHistoryView(
            turns=turns_from_messages(
                snapshot.messages,
                turn_states={child_run_id: state},
                turn_errors={
                    child_run_id: None if state == "cancelled" else run_error_from_events(events)
                },
                display=self.display,
            ),
            context_tokens=None,
        )

    async def _cancelled(self, run_id: str) -> bool:
        return run_state_from_events(await self.store.list_events(run_id=run_id)) == "cancelled"

    async def _subagent_of_call(self, messages: Sequence[ModelMessage]) -> dict[str, str]:
        if self.delegate_tool is None:
            return {}
        calls = [
            (message.run_id, part.tool_call_id)
            for message in messages
            if isinstance(message, ModelResponse) and message.run_id is not None
            for part in message.parts
            if isinstance(part, ToolCallPart) and part.tool_name == self.delegate_tool
        ]
        effects = await self.store.get_tool_effects(calls)
        found: dict[str, str] = {}
        for key in calls:
            effect = effects.get(key)
            if effect is not None and effect.effect_summary is not None:
                found[key[1]] = effect.effect_summary
        return found

    async def _child_runs(
        self, run_ids: Sequence[str], run_states: Mapping[str, TurnState]
    ) -> tuple[ChildRun, ...]:
        if self.delegate_tool is None:
            return ()
        children_of = await self.store.list_child_runs(run_ids)
        child_ids = [record.run_id for run_id in run_ids for record in children_of[run_id]]
        fetched = await self.store.list_events_for_runs(child_ids)
        children: list[ChildRun] = []
        for run_id in run_ids:
            if not children_of[run_id]:
                continue
            parent_state = run_states[run_id]
            for record in children_of[run_id]:
                events = fetched[record.run_id]
                state = run_state_from_events(events)
                if not _ended(events) and parent_state == "cancelled":
                    state = "cancelled"
                profile = cast("SubAgentProfile", record.metadata)
                children.append(
                    ChildRun(
                        run_id=record.run_id,
                        agent_name=profile.get("agent_name"),
                        started_at=record.started_at,
                        ended_at=events[-1].timestamp if events else None,
                        state=state,
                        model=profile.get("model"),
                        thinking_effort=profile.get("thinking_effort"),
                    )
                )
        return tuple(children)

    async def turn_count(self, conversation_id: str) -> int:
        snapshot = await self.store.latest_conversation_snapshot(
            conversation_id=conversation_id, include_interrupted=True
        )
        messages = [] if snapshot is None else snapshot.messages
        of_run = await self.prompt_runs.prompt_of_runs(conversation_id)
        return len(turn_run_ids(messages, of_run))

    async def plan_fork(
        self, conversation_id: str, *, ordinal: int, target_conversation_id: str
    ) -> ForkSeed | None:
        snapshot = await self.store.latest_conversation_snapshot(
            conversation_id=conversation_id, include_interrupted=True
        )
        messages = [] if snapshot is None else snapshot.messages
        of_run = await self.prompt_runs.prompt_of_runs(conversation_id)
        if not 1 <= ordinal <= len(turn_run_ids(messages, of_run)):
            return None
        return ForkSeed(
            store=self.store,
            conversation_id=target_conversation_id,
            kept=keep_turns(messages, of_run, ordinal=ordinal),
        )

    async def plan_rewind(self, conversation_id: str, *, ordinal: int) -> TurnRewind | None:
        snapshot = await self.store.latest_conversation_snapshot(
            conversation_id=conversation_id, include_interrupted=True
        )
        messages = [] if snapshot is None else snapshot.messages
        of_run = await self.prompt_runs.prompt_of_runs(conversation_id)
        if ordinal != len(turn_run_ids(messages, of_run)):
            return None
        kept, dropped = drop_last_turn(messages, of_run)
        return TurnRewind(
            store=self.store, conversation_id=conversation_id, kept=kept, run_ids=dropped
        )


def _run_states(
    run_ids: Sequence[str], events_of: Mapping[str, Sequence[StepEvent]]
) -> dict[str, TurnState]:
    return {run_id: run_state_from_events(events_of[run_id]) for run_id in run_ids}


def _ended(events: Sequence[StepEvent]) -> bool:
    return any(event.kind in {"run_completed", "run_failed"} for event in events)


@dataclass(frozen=True, slots=True)
class ForkSeed:
    store: ConversationSnapshots
    conversation_id: str
    kept: list[ModelMessage]

    async def commit(self) -> None:
        await self.store.save_snapshot(
            ContinuableSnapshot(
                run_id=f"fork-{uuid.uuid4().hex[:8]}",
                step_index=0,
                messages=self.kept,
                conversation_id=self.conversation_id,
            )
        )


@dataclass(frozen=True, slots=True)
class TurnRewind:
    store: ConversationSnapshots
    conversation_id: str
    kept: list[ModelMessage]
    run_ids: tuple[str, ...]

    async def commit(self) -> None:
        await self.store.save_snapshot(
            ContinuableSnapshot(
                run_id=f"regenerate-{uuid.uuid4().hex[:8]}",
                step_index=0,
                messages=self.kept,
                conversation_id=self.conversation_id,
            )
        )


__all__ = [
    "ConversationSnapshots",
    "ForkSeed",
    "PromptRunsSource",
    "TranscriptHistory",
    "TurnRewind",
]
