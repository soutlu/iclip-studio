from __future__ import annotations

import asyncio
import uuid
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol

import structlog
from pydantic_ai import Agent, CancellationToken, ToolFailed
from pydantic_ai.capabilities import AbstractCapability, on_event
from pydantic_ai.exceptions import UserError
from pydantic_ai.messages import (
    INTERRUPTED_TOOL_RETURN_CONTENT,
    EnqueuedMessagesEvent,
    ModelMessage,
    ModelRequest,
    ModelResponse,
    UserContent,
)
from pydantic_ai.tools import DeferredToolResults, RunContext
from pydantic_ai_harness.compaction import ReportContextUsage, SummarizingCompaction
from pydantic_ai_harness.step_persistence import ContinuableSnapshot

from cue.errors import AgentUnavailable, Conflict, HookRejected, NotFound
from cue.harness.agents import DELEGATE_TOOL
from cue.harness.background import interrupt_stale_receipts
from cue.harness.context_compaction import ContextCompaction
from cue.harness.job_status import JobStatus
from cue.harness.jobs import STEERED_ABORT_CONFLICT, JobQueue, JobRow
from cue.harness.transcript.from_messages import (
    ORPHAN_TOOL_ERROR,
    run_ids_from_messages,
    turn_run_ids,
    unanswered_tool_calls,
)
from cue.harness.transcript.history import ConversationSnapshots, TranscriptHistory
from cue.harness.transcript.projector import TranscriptEventStream
from cue.harness.transcript.prompt_media import model_prompt
from cue.harness.transcript.store import TranscriptStore
from cue.harness.transcript.subagents import SubAgentBridge
from cue.transcript.display import ToolDisplayRegistry
from cue.transcript.ops import (
    APPROVAL_ID_PREFIX,
    MAIN_AGENT_ID,
    EmittableOperation,
    FrameUpsertOp,
    Interaction,
    InteractionUpsertOp,
    MetaMergeOp,
    PromptUpsertOp,
    StepHeader,
    StepUpsertOp,
    TaskUpsertOp,
    ToolFrame,
    TranscriptMeta,
    TranscriptTask,
    TranscriptTurn,
    TurnHeader,
    TurnUpsertOp,
    owned_task_ids,
)

_logger = structlog.stdlib.get_logger(__name__)


@dataclass(frozen=True, slots=True)
class RunAgent:
    agent: Agent[Any, Any]
    context_window: int | None


class RunAgents(Protocol):
    async def for_conversation(self, conversation_id: str, agent_id: str) -> RunAgent: ...


DepsFor = Callable[[JobRow], Awaitable[Any]]

TurnStarted = Callable[[JobRow], Awaitable[None]]

RunStarted = Callable[[JobRow, str], Awaitable[None]]


def _now() -> datetime:
    return datetime.now(UTC)


def _close_out(history: Sequence[ModelMessage]) -> DeferredToolResults | None:
    pending = unanswered_tool_calls(history)
    if not pending:
        return None
    return DeferredToolResults(
        calls={item: ToolFailed(INTERRUPTED_TOOL_RETURN_CONTENT) for item in pending}
    )


def _approvals_of(row: JobRow, history: Sequence[ModelMessage]) -> DeferredToolResults:
    pending = unanswered_tool_calls(history)
    missing = [item for item in pending if item not in row.decisions]
    if missing:
        raise RuntimeError(f"这几次调用还没有审批结果，续跑起不来：{missing}")
    return DeferredToolResults(approvals={item: row.decisions[item] for item in pending})


def _seed_ops(
    turn: TranscriptTurn, tasks: Sequence[TranscriptTask], *, last_step_interrupted: bool
) -> tuple[EmittableOperation, ...]:
    ops: list[EmittableOperation] = [
        TurnUpsertOp(
            turn=TurnHeader.model_validate(
                turn.model_dump(exclude={"steps"}) | {"state": "running"}
            )
        )
    ]
    for index, step in enumerate(turn.steps):
        header = StepHeader.model_validate(step.model_dump(exclude={"frames"}))
        if last_step_interrupted and index == len(turn.steps) - 1:
            header = header.model_copy(update={"state": "interrupted"})
        ops.append(StepUpsertOp(turn_id=turn.turn_id, step=header))
        ops.extend(
            FrameUpsertOp(turn_id=turn.turn_id, step_id=step.step_id, frame=frame)
            for frame in step.frames
        )
    owned = owned_task_ids(frame for step in turn.steps for frame in step.frames)
    ops.extend(TaskUpsertOp(task=task) for task in tasks if task.task_id in owned)
    return tuple(ops)


@dataclass
class _RunHandle(AbstractCapability[Any]):
    delivered: Callable[[str], Awaitable[None]]
    ctx: RunContext[Any] | None = None

    async def before_run(self, ctx: RunContext[Any]) -> None:
        self.ctx = ctx

    def deliver(self, content: list[UserContent]) -> str | None:
        if self.ctx is None:
            return None
        try:
            return self.ctx.enqueue(*content, priority="asap")
        except UserError:
            return None

    @on_event(EnqueuedMessagesEvent)
    async def acknowledge(self, ctx: RunContext[Any], event: EnqueuedMessagesEvent) -> None:
        await self.delivered(event.enqueue_id)


@dataclass(slots=True)
class _Active:
    prompt_id: str
    conversation_id: str
    run_id: str
    turn_id: str
    token: CancellationToken
    handle: _RunHandle
    steered: dict[str, str] = field(default_factory=dict[str, str])
    pending: set[str] = field(default_factory=set[str])


class ConversationRunner:
    def __init__(
        self,
        *,
        agents: RunAgents,
        store: TranscriptStore,
        queue: JobQueue,
        snapshots: ConversationSnapshots,
        history: TranscriptHistory,
        deps_for: DepsFor,
        heartbeat_seconds: int,
        lease_seconds: int,
        sweep_seconds: int,
        max_attempts: int,
        compaction_max_fraction: float = 0.85,
        compaction_keep_messages: int = 20,
        on_turn_started: TurnStarted | None = None,
        on_run_started: RunStarted | None = None,
        display: ToolDisplayRegistry = ToolDisplayRegistry.EMPTY,
    ) -> None:
        self._agents = agents
        self._store = store
        self._queue = queue
        self._snapshots = snapshots
        self._history = history
        self._deps_for = deps_for
        self._heartbeat_seconds = heartbeat_seconds
        self._lease_seconds = lease_seconds
        self._sweep_seconds = sweep_seconds
        self._max_attempts = max_attempts
        self._compaction_max_fraction = compaction_max_fraction
        self._compaction_keep_messages = compaction_keep_messages
        self._display = display
        self.locked_by = uuid.uuid4().hex
        self._on_turn_started = on_turn_started
        self._on_run_started = on_run_started
        self._active: dict[str, _Active] = {}
        self._closing = False
        self._tasks: set[asyncio.Task[None]] = set()
        self._side_tasks: set[asyncio.Task[None]] = set()
        self._loops: tuple[asyncio.Task[None], ...] = ()

    @property
    def agents(self) -> RunAgents:
        return self._agents

    async def submit(self, row: JobRow) -> JobRow:
        self._publish(row)
        if row.status == "running":
            self._spawn(row)
        return row

    async def start(self) -> None:
        await self.sweep_once()
        self._loops = (
            asyncio.create_task(self._loop(self._heartbeat_seconds, self.heartbeat_once)),
            asyncio.create_task(self._loop(self._sweep_seconds, self.sweep_once)),
        )

    async def heartbeat_once(self) -> None:
        alive = set(await self._queue.heartbeat(locked_by=self.locked_by))
        for active in tuple(self._active.values()):
            if active.prompt_id in alive:
                continue
            _logger.warning("这一轮的租约已经不在手上，取消它", prompt_id=active.prompt_id)
            active.token.cancel()

    async def sweep_once(self) -> None:
        for row in await self._queue.fail_exhausted(
            lease_seconds=self._lease_seconds, max_attempts=self._max_attempts
        ):
            self._publish(row)
            if row.run_id is None:
                continue
            for child in await self._queue.settle_steered(row.run_id, status="failed", now=_now()):
                self._publish(child)
        if self._closing:
            return
        for row in await self._queue.claim_interrupted(
            locked_by=self.locked_by,
            lease_seconds=self._lease_seconds,
            max_attempts=self._max_attempts,
        ):
            self._publish(row)
            self._spawn(row)
        for conversation_id in await self._queue.conversations_waiting():
            row = await self._queue.start_next(conversation_id, locked_by=self.locked_by)
            if row is not None:
                self._publish(row)
                self._spawn(row)

    async def _loop(self, seconds: int, once: Callable[[], Awaitable[None]]) -> None:
        while True:
            await asyncio.sleep(seconds)
            try:
                await once()
            except Exception:
                _logger.exception("后台循环这一轮没做完")

    async def shutdown(self) -> None:
        self._closing = True
        for loop in self._loops:
            loop.cancel()
        await asyncio.gather(*self._loops, return_exceptions=True)
        self._loops = ()
        while pending := [task for task in self._tasks if not task.done()]:
            for active in tuple(self._active.values()):
                active.token.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
        for task in self._side_tasks:
            task.cancel()
        await asyncio.gather(*self._side_tasks, return_exceptions=True)

    async def abort(self, conversation_id: str, prompt_id: str) -> None:
        active = self._active.get(conversation_id)
        if active is not None and prompt_id in active.pending:
            raise Conflict(STEERED_ABORT_CONFLICT)
        row = await self._queue.abort(prompt_id, conversation_id=conversation_id, now=_now())
        if row.status == "aborted":
            self._publish(row)
            if row.run_id is not None:
                await self._cancel_awaiting(row)
            return
        active = self._active.get(row.conversation_id)
        if active is not None and active.prompt_id == prompt_id:
            active.token.cancel()

    async def abort_conversation(self, conversation_id: str) -> None:
        for row in await self._queue.abort_queued(conversation_id, now=_now()):
            self._publish(row)
        active = self._active.get(conversation_id)
        if active is not None:
            active.token.cancel()
            return
        waiting = (await self._queue.view(conversation_id)).active
        if waiting is not None and waiting.status == "awaiting":
            await self.abort(conversation_id, waiting.prompt_id)

    async def steer(self, conversation_id: str, prompt_ids: tuple[str, ...]) -> None:
        active = self._active.get(conversation_id)
        if active is None:
            waiting = (await self._queue.view(conversation_id)).active
            if waiting is not None and waiting.status == "awaiting":
                raise Conflict("这段对话在等审批，插不进去")
            raise Conflict("这段对话现在没有在跑的运行，插不进去")
        picked = await self._queue.pick_for_steer(conversation_id, prompt_ids)
        if self._active.get(conversation_id) is not active:
            await self._start_next(conversation_id)
            return
        fresh = {row.prompt_id: row for row in picked if row.prompt_id not in active.pending}
        prompts = [(row, model_prompt(row.content)) for row in fresh.values()]
        for row, prompt in prompts:
            enqueue_id = active.handle.deliver(prompt)
            if enqueue_id is None:
                continue
            active.steered[enqueue_id] = row.prompt_id
            active.pending.add(row.prompt_id)

    async def _acknowledge(self, active: _Active, enqueue_id: str) -> None:
        prompt_id = active.steered.get(enqueue_id)
        if prompt_id is None:
            return
        for row in await self._queue.mark_steered((prompt_id,), run_id=active.run_id, now=_now()):
            self._publish(row)
        active.pending.discard(prompt_id)

    async def approve(self, conversation_id: str, interaction_id: str, *, approved: bool) -> None:
        row = (await self._queue.view(conversation_id)).active
        if row is None or row.status != "awaiting":
            raise NotFound(f"没有等着回应的审批：{interaction_id}")
        tool_call_id = interaction_id.removeprefix(APPROVAL_ID_PREFIX)
        pending = unanswered_tool_calls(await self._messages(conversation_id))
        if tool_call_id not in pending:
            raise NotFound(f"没有等着回应的审批：{interaction_id}")
        recorded = await self._queue.record_decision(row.prompt_id, tool_call_id, approved=approved)
        self._store.append(
            conversation_id,
            MAIN_AGENT_ID,
            (
                InteractionUpsertOp(
                    interaction=Interaction(
                        interaction_id=interaction_id,
                        interaction_kind="approval",
                        tool_call_id=tool_call_id,
                        state="approved" if approved else "rejected",
                    )
                ),
            ),
        )
        if any(item not in recorded.decisions for item in pending):
            return
        claimed = await self._queue.claim_for_continuation(
            recorded.prompt_id, locked_by=self.locked_by
        )
        if claimed is None:
            return
        self._publish(claimed)
        self._spawn(recorded)

    async def _cancel_awaiting(self, row: JobRow) -> None:
        if row.run_id is not None:
            for child in await self._queue.settle_steered(row.run_id, status="aborted", now=_now()):
                self._publish(child)
        view = self._store.subscribe_view(row.conversation_id, MAIN_AGENT_ID)
        turn = next((item for item in view.live_turns if item.state == "running"), None)
        waiting = self._store.pending_interactions(row.conversation_id, MAIN_AGENT_ID)
        ops: list[EmittableOperation] = [
            InteractionUpsertOp(interaction=item.model_copy(update={"state": "cancelled"}))
            for item in waiting
        ]
        if turn is not None:
            answered = {item.tool_call_id for item in waiting}
            ops.extend(
                FrameUpsertOp(
                    turn_id=turn.turn_id,
                    step_id=step.step_id,
                    frame=frame.model_copy(update={"state": "error", "error": ORPHAN_TOOL_ERROR}),
                )
                for step in turn.steps
                for frame in step.frames
                if isinstance(frame, ToolFrame) and frame.tool_call_id in answered
            )
            ended = _now()
            duration_ms = (
                None
                if turn.started_at is None
                else int((ended - datetime.fromisoformat(turn.started_at)).total_seconds() * 1000)
            )
            ops.append(
                TurnUpsertOp(
                    turn=TurnHeader.model_validate(
                        turn.model_dump(exclude={"steps"})
                        | {
                            "state": "cancelled",
                            "ended_at": ended.isoformat(),
                            "duration_ms": duration_ms,
                        }
                    )
                )
            )
        ops.append(MetaMergeOp(meta=TranscriptMeta(activity="idle")))
        self._store.append(row.conversation_id, MAIN_AGENT_ID, tuple(ops))
        if turn is not None and row.run_id is not None:
            await self._hand_over(row.conversation_id, run_id=row.run_id, turn_id=turn.turn_id)
        await self._start_next(row.conversation_id)

    async def _start_next(self, conversation_id: str) -> None:
        if self._closing:
            return
        following = await self._queue.start_next(conversation_id, locked_by=self.locked_by)
        if following is not None:
            self._publish(following)
            self._spawn(following)

    def _spawn(self, row: JobRow) -> None:
        task = asyncio.create_task(self._drive(row))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _drive(self, row: JobRow) -> None:
        self._store.pin(row.conversation_id)
        status: JobStatus | None = "failed"
        reason: str | None = None
        try:
            status = await self._run_once(row)
        except AgentUnavailable as exc:
            reason = f"{exc.code}: {exc}"
            _logger.warning(
                "对话的 agent 装配不起来，这次运行记为失败",
                prompt_id=row.prompt_id,
                conversation_id=row.conversation_id,
                code=exc.code,
                reason=str(exc),
            )
        except HookRejected as exc:
            reason = f"{exc.code}: {exc}"
            _logger.warning(
                "开跑检查没放行，这次运行记为失败",
                prompt_id=row.prompt_id,
                conversation_id=row.conversation_id,
                code=exc.code,
                reason=str(exc),
            )
        except Exception:
            _logger.exception("这次运行没跑完", prompt_id=row.prompt_id)
        finally:
            active = None if status is None else self._active.pop(row.conversation_id, None)
            self._store.unpin(row.conversation_id)
            if status is None:
                pass
            elif status == "awaiting":
                # awaiting 状态暂不结算轮次或启动下一条消息。
                pass
            elif self._closing and status == "aborted":
                await self._release(row)
            else:
                await self._settle(active, status=status)
                await self._queue.finish(
                    row.prompt_id,
                    status=status,
                    now=_now(),
                    locked_by=self.locked_by,
                    attempt=row.attempt,
                    reason=reason,
                )
                settled = await self._queue.get(row.prompt_id)
                if settled is not None:
                    self._publish(settled)
                await self._start_next(row.conversation_id)

    async def _release(self, row: JobRow) -> None:
        await self._queue.release(
            row.prompt_id,
            locked_by=self.locked_by,
            reason="服务关停，等待续跑",
            attempt=row.attempt,
        )
        released = await self._queue.get(row.prompt_id)
        if released is not None:
            self._publish(released)

    def _spawn_turn_started(self, row: JobRow) -> None:
        if self._on_turn_started is None:
            return
        task = asyncio.create_task(self._turn_started(self._on_turn_started, row))
        self._side_tasks.add(task)
        task.add_done_callback(self._side_tasks.discard)

    async def _turn_started(self, action: TurnStarted, row: JobRow) -> None:
        try:
            await action(row)
        except Exception:
            _logger.exception("这一轮的开场动作没做完", prompt_id=row.prompt_id)

    async def _run_started(self, row: JobRow, run_id: str) -> None:
        if self._on_run_started is None:
            return
        try:
            await self._on_run_started(row, run_id)
        except Exception:
            _logger.exception("这次运行的开场动作没做完", prompt_id=row.prompt_id, run_id=run_id)

    async def _settle(self, active: _Active | None, *, status: JobStatus) -> None:
        if active is None:
            return
        if status == "aborted" and active.pending:
            for row in await self._queue.abort_queued(
                active.conversation_id, now=_now(), only=tuple(active.pending)
            ):
                self._publish(row)
        for child in await self._queue.settle_steered(active.run_id, status=status, now=_now()):
            self._publish(child)

    async def _run_once(self, row: JobRow) -> JobStatus | None:
        resolved = await self._agents.for_conversation(row.conversation_id, row.agent_id)
        agent = resolved.agent
        context_window = resolved.context_window

        awaiting = row.status == "awaiting"
        history = interrupt_stale_receipts(await self._messages(row.conversation_id))
        prompt_of_run = await self._queue.prompt_of_runs(row.conversation_id)
        turns = turn_run_ids(history, prompt_of_run)
        resumed = (
            None
            if row.run_id is None
            else next((index for index, group in enumerate(turns) if row.run_id in group), None)
        )
        ordinal = len(turns) + 1 if resumed is None else resumed + 1
        turn_id = f"t{ordinal}"
        run_id = f"{row.agent_id}-{uuid.uuid4().hex[:8]}"
        attached = await self._queue.attach_run(
            row.prompt_id, run_id, locked_by=self.locked_by, attempt=row.attempt
        )
        if not attached:
            _logger.warning("开跑前租约已经不在手上，放弃这次运行", prompt_id=row.prompt_id)
            return None
        if row.run_id is not None:
            await self._queue.adopt_steered(row.run_id, run_id)
        await self._run_started(row, run_id)
        if not awaiting and resumed is None:
            self._spawn_turn_started(row)

        async def delivered(enqueue_id: str) -> None:
            await self._acknowledge(active, enqueue_id)

        active = _Active(
            prompt_id=row.prompt_id,
            conversation_id=row.conversation_id,
            run_id=run_id,
            turn_id=turn_id,
            token=CancellationToken(),
            handle=_RunHandle(delivered=delivered),
        )
        self._active[row.conversation_id] = active

        baseline = None if resumed is None else await self._history.read(row.conversation_id)
        resume_from = None if baseline is None or resumed is None else baseline.turns[resumed]
        crashed_run = None if resumed is None or awaiting else row.run_id
        if crashed_run is not None:
            unresolved = await self._snapshots.list_unresolved_tool_effects(run_id=crashed_run)
            if unresolved:
                _logger.warning(
                    "续跑前有没收尾的工具副作用",
                    effects=[(r.tool_name, r.tool_call_id, r.idempotency_key) for r in unresolved],
                )
        tail = history[-1] if history else None
        repaired = (
            unanswered_tool_calls(history)
            if crashed_run is not None
            and isinstance(tail, ModelRequest)
            and tail.state == "interrupted"
            else ()
        )
        projector = TranscriptEventStream(
            turn_id=turn_id,
            turn_ordinal=ordinal,
            run_id=run_id,
            content=row.content,
            prompt_id=row.prompt_id,
            steered=active.steered,
            max_context_tokens=context_window,
            resume_from=resume_from,
            repaired_calls=repaired,
            display=self._display,
        )
        if baseline is not None and resume_from is not None:
            self._store.append(
                row.conversation_id,
                MAIN_AGENT_ID,
                _seed_ops(resume_from, baseline.tasks, last_step_interrupted=not awaiting),
            )

        deps = await self._deps_for(row)
        user_prompt: list[UserContent] | None = None
        deferred_results: DeferredToolResults | None = None
        if awaiting:
            deferred_results = _approvals_of(row, history)
        elif crashed_run is None:
            user_prompt = model_prompt(row.content)
            deferred_results = _close_out(history)
        async with agent.run_stream_events(
            user_prompt,
            message_history=history,
            deferred_tool_results=deferred_results,
            conversation_id=row.conversation_id,
            run_id=run_id,
            deps=deps,
            cancellation_token=active.token,
            capabilities=[
                active.handle,
                SubAgentBridge(
                    store=self._snapshots,
                    live=self._store,
                    conversation_id=row.conversation_id,
                    projector=projector,
                    delegate_tool=DELEGATE_TOOL,
                ),
                *(
                    [
                        ContextCompaction(
                            strategy=SummarizingCompaction(
                                max_messages=1,
                                keep_messages=self._compaction_keep_messages,
                                preserve_first_user_message=False,
                            ),
                            max_tokens=int(context_window * self._compaction_max_fraction),
                            on_compaction=projector.note_compaction,
                        ),
                        ReportContextUsage(context_window=context_window),
                    ]
                    if context_window is not None
                    else []
                ),
            ],
        ) as events:
            async for batch in projector.transform_stream(events):
                self._store.append(row.conversation_id, MAIN_AGENT_ID, batch)

        if projector.deferred is not None:
            return await self._await_approvals(row, run_id=run_id, history=projector.final_history)
        await self._persist_if_unsaved(
            row.conversation_id, run_id=run_id, history=projector.final_history
        )
        await self._hand_over(row.conversation_id, run_id=run_id, turn_id=turn_id)
        if projector.cancelled is not None:
            return "aborted"
        return "failed" if projector.failed else "completed"

    async def _persist_if_unsaved(
        self, conversation_id: str, *, run_id: str, history: Sequence[ModelMessage]
    ) -> None:
        if not history or run_id in await self._derived_run_ids(conversation_id):
            return
        _logger.warning("官方没存下这一轮的快照，运行驱动兜底存一份", run_id=run_id)
        await self._save_history(conversation_id, run_id=run_id, history=history)

    async def _save_history(
        self, conversation_id: str, *, run_id: str, history: Sequence[ModelMessage]
    ) -> None:
        await self._snapshots.save_snapshot(
            ContinuableSnapshot(
                run_id=run_id,
                step_index=sum(
                    1
                    for message in history
                    if isinstance(message, ModelResponse) and message.run_id == run_id
                ),
                messages=list(history),
                conversation_id=conversation_id,
                state="interrupted",
            )
        )

    async def _await_approvals(
        self, row: JobRow, *, run_id: str, history: Sequence[ModelMessage]
    ) -> JobStatus:
        await self._save_history(row.conversation_id, run_id=run_id, history=history)
        waiting = await self._queue.await_approvals(
            row.prompt_id, locked_by=self.locked_by, attempt=row.attempt
        )
        if waiting is not None:
            self._publish(waiting)
        return "awaiting"

    async def _messages(self, conversation_id: str) -> list[ModelMessage]:
        snapshot = await self._snapshots.latest_conversation_snapshot(
            conversation_id=conversation_id, include_interrupted=True
        )
        return [] if snapshot is None else list(snapshot.messages)

    async def _derived_run_ids(self, conversation_id: str) -> tuple[str, ...]:
        snapshot = await self._snapshots.latest_conversation_snapshot(
            conversation_id=conversation_id, include_interrupted=True
        )
        return () if snapshot is None else tuple(run_ids_from_messages(snapshot.messages))

    async def _hand_over(self, conversation_id: str, *, run_id: str, turn_id: str) -> None:
        if run_id not in await self._derived_run_ids(conversation_id):
            _logger.warning("这一轮还没落进消息历史，先留在实时状态里", run_id=run_id)
            return
        self._store.mark_snapshot_persisted(conversation_id, MAIN_AGENT_ID, turn_id)
        self._store.drop_persisted_turns(conversation_id, MAIN_AGENT_ID)

    def _publish(self, row: JobRow) -> None:
        self._store.append(
            row.conversation_id, MAIN_AGENT_ID, (PromptUpsertOp(prompt=row.as_entity()),)
        )


__all__ = [
    "ConversationRunner",
    "ConversationSnapshots",
    "DepsFor",
    "RunAgent",
    "RunAgents",
    "RunStarted",
    "TurnStarted",
]
