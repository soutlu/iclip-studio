from __future__ import annotations

import json
from collections.abc import AsyncIterator, Collection, Mapping, Sequence
from dataclasses import KW_ONLY, dataclass, field
from datetime import UTC, datetime
from typing import Any

from pydantic_ai.exceptions import RunCancelled
from pydantic_ai.messages import (
    INTERRUPTED_TOOL_RETURN_CONTENT,
    CapabilityEvent,
    DeferredToolRequestsEvent,
    DeferredToolResultsEvent,
    EnqueuedMessagesEvent,
    FunctionToolCallEvent,
    FunctionToolResultEvent,
    ModelMessage,
    ModelResponse,
    PartStartEvent,
    TextPart,
    TextPartDelta,
    ThinkingPart,
    ThinkingPartDelta,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai.run import AgentRunResultEvent
from pydantic_ai.tools import DeferredToolRequests, DeferredToolResults, ToolDenied
from pydantic_ai.ui import UIEventStream
from pydantic_ai_harness.compaction import ContextUsageEvent, estimate_context_tokens

from cue.harness.agents import SubAgentProfile
from cue.harness.background import BackgroundOutcome, is_receipt, parse_outcome
from cue.harness.context_compaction import (
    compaction_only,
    recorded_load_call,
    recorded_loads,
)
from cue.harness.transcript.from_messages import (
    ORPHAN_TOOL_ERROR,
    TurnState,
    background_notice,
    background_task,
    interrupted_task_state,
    recorded_load_card,
    settle_background_task,
    settle_tool_return,
    step_usage,
    thinking_delta_text,
    thinking_text,
    turn_usage,
)
from cue.harness.transcript.prompt_media import plain_text, prompt_content
from cue.transcript.display import ToolDisplayRegistry
from cue.transcript.ops import (
    APPROVAL_ID_PREFIX,
    COMPACTION_NOTICE,
    MAIN_AGENT_ID,
    AgentRef,
    AppendOp,
    EmittableOperation,
    FrameTarget,
    FrameUpsertOp,
    Interaction,
    InteractionUpsertOp,
    MetaMergeOp,
    NoticeFrame,
    PromptContent,
    StepHeader,
    StepUpsertOp,
    StepUsage,
    TaskState,
    TaskUpsertOp,
    TextFrame,
    ThinkingFrame,
    ToolFrame,
    TranscriptMeta,
    TranscriptTask,
    TranscriptTurn,
    TurnHeader,
    TurnOrigin,
    TurnUpsertOp,
    agent_context_status,
    next_frame_ordinal,
    utf16_len,
)

OpsBatch = tuple[EmittableOperation, ...]


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _millis_since(started_at: str, ended_at: datetime) -> int:
    return int((ended_at - datetime.fromisoformat(started_at)).total_seconds() * 1000)


_Steer = tuple[tuple[PromptContent, ...], tuple[str, ...] | None]


def _step_of(card: ToolFrame) -> str:
    return card.frame_id[: -len(card.tool_call_id) - 1]


@dataclass
class TranscriptEventStream(UIEventStream[Any, OpsBatch, Any, Any]):
    _: KW_ONLY

    agent_id: str = MAIN_AGENT_ID
    turn_id: str = "t1"
    turn_ordinal: int = 1
    run_id: str | None = None
    content: tuple[PromptContent, ...] = ()
    prompt_id: str | None = None
    steered: Mapping[str, str] = field(default_factory=dict)
    max_context_tokens: int | None = None
    resume_from: TranscriptTurn | None = None
    repaired_calls: tuple[str, ...] = ()
    display: ToolDisplayRegistry = ToolDisplayRegistry.EMPTY

    _started_at: str = field(default_factory=_now, init=False)
    _step_started_at: str | None = field(default=None, init=False)
    _in_response: bool = field(default=False, init=False)
    _pending_step_break: bool = field(default=False, init=False)
    _step_ordinal: int = field(default=0, init=False)
    _frame_ids: list[str] = field(default_factory=list[str], init=False)
    _open_frame_id: str | None = field(default=None, init=False)
    _open_text: str = field(default="", init=False)
    _step_usage: list[StepUsage] = field(default_factory=list[StepUsage], init=False)
    _tool_cards: dict[str, ToolFrame] = field(default_factory=dict[str, ToolFrame], init=False)
    _subagent_tasks: dict[str, TranscriptTask] = field(
        default_factory=dict[str, TranscriptTask], init=False
    )
    _background_tasks: dict[str, TranscriptTask] = field(
        default_factory=dict[str, TranscriptTask], init=False
    )
    _step_headers: list[StepHeader] = field(default_factory=list[StepHeader], init=False)
    _pending_steers: list[_Steer] = field(default_factory=list[_Steer], init=False)
    _settled_calls: set[str] = field(default_factory=set[str], init=False)
    _pending_summary: str | None = field(default=None, init=False)
    _pending_loads: list[tuple[ToolCallPart, ToolReturnPart]] = field(
        default_factory=list[tuple[ToolCallPart, ToolReturnPart]], init=False
    )

    deferred: DeferredToolRequests | None = field(default=None, init=False)
    final_history: tuple[ModelMessage, ...] = field(default=(), init=False)

    def __post_init__(self) -> None:
        turn = self.resume_from
        if turn is None:
            return
        self.content = turn.content
        if turn.started_at is not None:
            self._started_at = turn.started_at
        self._step_ordinal = len(turn.steps)
        self._step_usage = [step.usage for step in turn.steps if step.usage is not None]
        if not turn.steps:
            return
        last = turn.steps[-1]
        self._frame_ids = [frame.frame_id for frame in last.frames]
        self._tool_cards = {
            frame.tool_call_id: frame
            for frame in last.frames
            if isinstance(frame, ToolFrame)
            and (
                frame.state == "running"
                or (frame.state == "error" and frame.error == ORPHAN_TOOL_ERROR)
            )
        }

    def encode_event(self, event: OpsBatch) -> str:
        return json.dumps(
            [op.model_dump(by_alias=True, exclude_none=True) for op in event],
            ensure_ascii=False,
        )

    async def before_stream(self) -> AsyncIterator[OpsBatch]:
        yield (
            TurnUpsertOp(turn=self._turn_header(state="running")),
            MetaMergeOp(meta=TranscriptMeta(activity="turn")),
            *self._repaired_card_ops(),
        )

    async def after_stream(self) -> AsyncIterator[OpsBatch]:
        if self._cancelled is not None or self._closed_with_error:
            return
        if self.deferred is not None:
            waiting = {
                part.tool_call_id for part in (*self.deferred.approvals, *self.deferred.calls)
            }
            yield (
                *self._orphan_card_ops(keep_open=waiting),
                *self._orphan_background_ops("completed", paused_for_approval=True),
                TurnUpsertOp(turn=self._turn_header(state="running")),
            )
            return
        yield (
            *self._orphan_card_ops(),
            *self._orphan_task_ops("failed"),
            *self._orphan_background_ops("completed"),
            TurnUpsertOp(turn=self._turn_header(state="completed")),
            MetaMergeOp(meta=TranscriptMeta(activity="idle")),
        )

    async def on_cancelled(self, cancelled: RunCancelled) -> AsyncIterator[OpsBatch]:
        yield (
            *self._orphan_card_ops(),
            *self._orphan_task_ops("killed"),
            *self._orphan_background_ops("cancelled"),
            TurnUpsertOp(turn=self._turn_header(state="cancelled")),
            MetaMergeOp(meta=TranscriptMeta(activity="idle")),
        )

    async def on_error(self, error: Exception) -> AsyncIterator[OpsBatch]:
        self._closed_with_error = True
        yield (
            *self._orphan_card_ops(),
            *self._orphan_task_ops("failed"),
            *self._orphan_background_ops("failed"),
            TurnUpsertOp(turn=self._turn_header(state="failed", error=repr(error))),
            MetaMergeOp(meta=TranscriptMeta(activity="idle")),
        )

    def note_compaction(self, summary: str, records: Sequence[ModelMessage]) -> None:
        self._pending_summary = summary
        returns = recorded_loads(records)
        self._pending_loads.extend(
            (part, returns[part.tool_call_id])
            for message in records
            for part in message.parts
            if recorded_load_call(part, returns)
        )

    async def before_response(self) -> AsyncIterator[OpsBatch]:
        self._step_ordinal += 1
        self._step_started_at = _now()
        self._in_response = True
        self._frame_ids = []
        ops: list[EmittableOperation] = [
            StepUpsertOp(turn_id=self.turn_id, step=self._step(state="running"))
        ]
        if self._pending_summary is not None:
            ops.append(self._compaction_frame(self._pending_summary))
            self._pending_summary = None
        for call, returned in self._pending_loads:
            card = recorded_load_card(call, returned, step_id=self._step_id, display=self.display)
            ops.append(FrameUpsertOp(turn_id=self.turn_id, step_id=self._step_id, frame=card))
        self._pending_loads.clear()
        for said, prompt_ids in self._pending_steers:
            ops.extend(self._user_frame(said, prompt_ids))
        self._pending_steers.clear()
        yield tuple(ops)

    async def after_response(self) -> AsyncIterator[OpsBatch]:
        if self._step_ordinal == 0:
            return
        header = self._step(state="completed")
        self._step_headers.append(header)
        self._in_response = False
        yield (StepUpsertOp(turn_id=self.turn_id, step=header),)

    async def handle_run_result(self, event: AgentRunResultEvent[Any]) -> AsyncIterator[OpsBatch]:
        self.final_history = tuple(event.result.all_messages())
        if isinstance(event.result.output, DeferredToolRequests):
            self.deferred = event.result.output
        responses = step_responses(event.result.new_messages(), self.run_id)
        ops: list[EmittableOperation] = []
        for header, response in zip(self._step_headers, responses, strict=False):
            usage = step_usage(response.usage)
            if usage is None:
                continue
            self._step_usage.append(usage)
            ops.append(
                StepUpsertOp(
                    turn_id=self.turn_id,
                    step=header.model_copy(
                        update={"usage": usage, "finish_reason": response.finish_reason}
                    ),
                )
            )
        if self.max_context_tokens is not None:
            ops.append(
                MetaMergeOp(
                    meta=TranscriptMeta(
                        agent=agent_context_status(
                            estimate_context_tokens(event.result.all_messages()),
                            self.max_context_tokens,
                        )
                    )
                )
            )
        if ops:
            yield tuple(ops)

    async def handle_capability_event(self, event: CapabilityEvent) -> AsyncIterator[OpsBatch]:
        if not isinstance(event, ContextUsageEvent):
            return
        self.max_context_tokens = event.window_tokens
        yield (
            MetaMergeOp(
                meta=TranscriptMeta(
                    agent=agent_context_status(event.used_tokens, event.window_tokens)
                )
            ),
        )

    async def handle_part_start(self, event: PartStartEvent) -> AsyncIterator[OpsBatch]:
        if self._pending_step_break:
            self._pending_step_break = False
            async for batch in self.after_response():
                yield batch
            async for batch in self.before_response():
                yield batch
        async for batch in super().handle_part_start(event):
            yield batch

    async def handle_text_start(
        self, part: TextPart, follows_text: bool = False
    ) -> AsyncIterator[OpsBatch]:
        async for batch in self._open_text_frame(part.content, thinking=False):
            yield batch

    async def handle_text_delta(self, delta: TextPartDelta) -> AsyncIterator[OpsBatch]:
        async for batch in self._append(delta.content_delta):
            yield batch

    async def handle_text_end(
        self, part: TextPart, followed_by_text: bool = False
    ) -> AsyncIterator[OpsBatch]:
        async for batch in self._flush(TextFrame, role="assistant"):
            yield batch

    async def handle_thinking_start(
        self, part: ThinkingPart, follows_thinking: bool = False
    ) -> AsyncIterator[OpsBatch]:
        async for batch in self._open_text_frame(thinking_text(part), thinking=True):
            yield batch

    async def handle_thinking_delta(self, delta: ThinkingPartDelta) -> AsyncIterator[OpsBatch]:
        async for batch in self._append(thinking_delta_text(delta)):
            yield batch

    async def handle_thinking_end(
        self, part: ThinkingPart, followed_by_thinking: bool = False
    ) -> AsyncIterator[OpsBatch]:
        async for batch in self._flush(ThinkingFrame):
            yield batch

    async def handle_function_tool_call(
        self, event: FunctionToolCallEvent
    ) -> AsyncIterator[OpsBatch]:
        if self._step_ordinal == 0:
            return

        opened = self._tool_cards.get(event.part.tool_call_id)
        card = ToolFrame(
            frame_id=f"{self._step_id}.{event.part.tool_call_id}",
            tool_call_id=event.part.tool_call_id,
            name=event.part.tool_name,
            state="running",
            input=event.part.args,
            display=self.display.tool_display(event.part.tool_name, event.part.args),
            view=self.display.view_of(event.part.tool_name),
            approval_id=None if opened is None else opened.approval_id,
        )
        self._tool_cards[event.part.tool_call_id] = card
        yield (FrameUpsertOp(turn_id=self.turn_id, step_id=self._step_id, frame=card),)

    def note_subagent(
        self, tool_call_id: str, child_run_id: str, profile: SubAgentProfile
    ) -> OpsBatch:
        card = self._tool_cards[tool_call_id]
        stamped = card.model_copy(
            update={"agent_refs": (AgentRef(agent_id=child_run_id, role="child"),)}
        )
        self._tool_cards[tool_call_id] = stamped
        task = TranscriptTask(
            task_id=child_run_id,
            kind="subagent",
            state="running",
            detached=False,
            description=profile["agent_name"],
            agent_id=child_run_id,
            started_at=_now(),
            model=profile.get("model"),
            thinking_effort=profile.get("thinking_effort"),
        )
        self._subagent_tasks[tool_call_id] = task
        return (
            FrameUpsertOp(turn_id=self.turn_id, step_id=_step_of(stamped), frame=stamped),
            TaskUpsertOp(task=task),
        )

    async def handle_function_tool_result(
        self, event: FunctionToolResultEvent
    ) -> AsyncIterator[OpsBatch]:
        part = event.part
        opened = self._tool_cards.get(part.tool_call_id)
        if opened is None:
            return
        if part.tool_call_id in self._pending_tool_calls:
            return
        self._settled_calls.add(part.tool_call_id)
        state, output, metadata, error = settle_tool_return(part)
        stopped = part.outcome == "interrupted"
        ops: list[EmittableOperation] = [
            FrameUpsertOp(
                turn_id=self.turn_id,
                step_id=self._step_id,
                frame=opened.model_copy(
                    update={
                        "state": state,
                        "output": output,
                        "metadata": metadata,
                        "error": error,
                    }
                ),
            )
        ]
        task = self._subagent_tasks.get(part.tool_call_id)
        if task is not None:
            settled = task.model_copy(
                update={
                    "state": "completed" if state == "done" else "killed" if stopped else "failed",
                    "ended_at": _now(),
                    "result_summary": str(output) if state == "done" else None,
                    "error": None if state == "done" or stopped else error,
                }
            )
            self._subagent_tasks[part.tool_call_id] = settled
            ops.append(TaskUpsertOp(task=settled))
        if is_receipt(part):
            started = background_task(opened, started_at=_now())
            self._background_tasks[part.tool_call_id] = started
            ops.append(TaskUpsertOp(task=started))
        yield tuple(ops)

    async def handle_deferred_tool_requests(
        self, event: DeferredToolRequestsEvent
    ) -> AsyncIterator[OpsBatch]:
        ops: list[EmittableOperation] = []
        for part in event.requests.approvals:
            interaction_id = f"{APPROVAL_ID_PREFIX}{part.tool_call_id}"
            ops.append(
                InteractionUpsertOp(
                    interaction=Interaction(
                        interaction_id=interaction_id,
                        interaction_kind="approval",
                        tool_call_id=part.tool_call_id,
                        state="pending",
                    )
                )
            )
            card = self._tool_cards.get(part.tool_call_id)
            if card is None:
                continue
            stamped = card.model_copy(update={"approval_id": interaction_id})
            self._tool_cards[part.tool_call_id] = stamped
            ops.append(FrameUpsertOp(turn_id=self.turn_id, step_id=self._step_id, frame=stamped))
        if ops:
            yield tuple(ops)

    async def handle_deferred_tool_results(
        self, event: DeferredToolResultsEvent
    ) -> AsyncIterator[OpsBatch]:
        ops = [
            InteractionUpsertOp(
                interaction=Interaction(
                    interaction_id=f"{APPROVAL_ID_PREFIX}{tool_call_id}",
                    interaction_kind="approval",
                    tool_call_id=tool_call_id,
                    state="approved" if approved else "rejected",
                )
            )
            for tool_call_id, approved in _approvals(event.results)
        ]
        if ops:
            yield tuple(ops)

    async def handle_enqueued_messages(
        self, event: EnqueuedMessagesEvent
    ) -> AsyncIterator[OpsBatch]:
        prompt_id = self.steered.get(event.enqueue_id)
        prompt_ids = None if prompt_id is None else (prompt_id,)
        delivered = False
        ops: list[EmittableOperation] = []
        for message in event.messages:
            for part in message.parts:
                if not isinstance(part, UserPromptPart):
                    continue
                outcome = parse_outcome(part)
                if outcome is not None:
                    delivered = True
                    ops.extend(self._background_outcome_ops(outcome))
                elif content := _prompt_content(part):
                    delivered = True
                    if self._step_ordinal == 0:
                        self._pending_steers.append((content, prompt_ids))
                    else:
                        ops.extend(self._user_frame(content, prompt_ids))
        if delivered and self._in_response:
            self._pending_step_break = True
        if ops:
            yield tuple(ops)

    _closed_with_error: bool = field(default=False, init=False)

    @property
    def failed(self) -> bool:
        return self._closed_with_error

    @property
    def _step_id(self) -> str:
        return f"{self.turn_id}.{max(self._step_ordinal, 1)}"

    def _turn_header(self, *, state: str, error: str | None = None) -> TurnHeader:
        ended_at = None if state == "running" else datetime.now(UTC)
        return TurnHeader(
            turn_id=self.turn_id,
            trigger_prompt_id=self.prompt_id,
            ordinal=self.turn_ordinal,
            state=state,  # pyright: ignore[reportArgumentType]
            origin=TurnOrigin(kind="user"),
            content=self.content,
            started_at=self._started_at,
            ended_at=None if ended_at is None else ended_at.isoformat(),
            usage=turn_usage(self._step_usage),
            duration_ms=None if ended_at is None else _millis_since(self._started_at, ended_at),
            error=error,
        )

    def _step(self, *, state: str) -> StepHeader:
        return StepHeader(
            step_id=self._step_id,
            turn_id=self.turn_id,
            ordinal=max(self._step_ordinal, 1),
            state=state,  # pyright: ignore[reportArgumentType]
            started_at=self._step_started_at,
            ended_at=None if state == "running" else _now(),
        )

    def _orphan_card_ops(self, *, keep_open: Collection[str] = ()) -> list[EmittableOperation]:
        ops: list[EmittableOperation] = []
        for tool_call_id, card in self._tool_cards.items():
            if tool_call_id in keep_open:
                continue
            unsettled = tool_call_id not in self._settled_calls and card.state == "running"
            if not unsettled and not self._awaiting_outcome(tool_call_id):
                continue
            ops.append(
                FrameUpsertOp(
                    turn_id=self.turn_id,
                    step_id=_step_of(card),
                    frame=card.model_copy(
                        update={
                            "state": "error",
                            "output": None,
                            "metadata": None,
                            "error": ORPHAN_TOOL_ERROR,
                        }
                    ),
                )
            )
        return ops

    def _awaiting_outcome(self, tool_call_id: str) -> bool:
        task = self._background_tasks.get(tool_call_id)
        return task is not None and task.state == "running"

    def _orphan_task_ops(self, state: TaskState) -> list[EmittableOperation]:
        ops: list[EmittableOperation] = []
        for tool_call_id, task in self._subagent_tasks.items():
            if task.state != "running":
                continue
            settled = task.model_copy(update={"state": state, "ended_at": _now()})
            self._subagent_tasks[tool_call_id] = settled
            ops.append(TaskUpsertOp(task=settled))
        return ops

    def _orphan_background_ops(
        self, run_state: TurnState, *, paused_for_approval: bool = False
    ) -> list[EmittableOperation]:
        state = interrupted_task_state(run_state, paused_for_approval=paused_for_approval)
        ops: list[EmittableOperation] = []
        for tool_call_id, task in self._background_tasks.items():
            if task.state != "running":
                continue
            settled = task.model_copy(update={"state": state, "ended_at": _now()})
            self._background_tasks[tool_call_id] = settled
            ops.append(TaskUpsertOp(task=settled))
        return ops

    def _background_outcome_ops(self, outcome: BackgroundOutcome) -> list[EmittableOperation]:
        card = self._tool_cards.get(outcome.tool_call_id)
        if card is None:
            return []
        ops: list[EmittableOperation] = [
            FrameUpsertOp(
                turn_id=self.turn_id,
                step_id=self._step_id,
                frame=background_notice(card, outcome, frame_id=self._next_frame_id()),
            )
        ]
        task = self._background_tasks.get(outcome.tool_call_id)
        if task is not None:
            settled = settle_background_task(task, outcome, ended_at=_now())
            self._background_tasks[outcome.tool_call_id] = settled
            ops.append(TaskUpsertOp(task=settled))
        return ops

    def _repaired_card_ops(self) -> list[EmittableOperation]:
        ops: list[EmittableOperation] = []
        for tool_call_id in self.repaired_calls:
            card = self._tool_cards.get(tool_call_id)
            if card is None:
                continue
            state, output, metadata, error = settle_tool_return(
                ToolReturnPart(
                    tool_name=card.name,
                    content=INTERRUPTED_TOOL_RETURN_CONTENT,
                    tool_call_id=tool_call_id,
                    outcome="interrupted",
                )
            )
            settled = card.model_copy(
                update={"state": state, "output": output, "metadata": metadata, "error": error}
            )
            self._tool_cards[tool_call_id] = settled
            self._settled_calls.add(tool_call_id)
            ops.append(FrameUpsertOp(turn_id=self.turn_id, step_id=_step_of(card), frame=settled))
        return ops

    def _next_frame_id(self) -> str:
        frame_id = f"{self._step_id}.f{next_frame_ordinal(self._frame_ids)}"
        self._frame_ids.append(frame_id)
        return frame_id

    def _compaction_frame(self, summary: str) -> EmittableOperation:
        return FrameUpsertOp(
            turn_id=self.turn_id,
            step_id=self._step_id,
            frame=NoticeFrame(
                frame_id=f"{self._step_id}.compaction",
                level="info",
                message=COMPACTION_NOTICE,
                detail=summary,
            ),
        )

    def _user_frame(
        self, content: tuple[PromptContent, ...], prompt_ids: tuple[str, ...] | None
    ) -> list[EmittableOperation]:
        frame_id = self._next_frame_id()
        return [
            FrameUpsertOp(
                turn_id=self.turn_id,
                step_id=self._step_id,
                frame=TextFrame(
                    frame_id=frame_id,
                    role="user",
                    text=plain_text(content),
                    content=content,
                    prompt_ids=prompt_ids,
                ),
            )
        ]

    async def _open_text_frame(self, initial: str, *, thinking: bool) -> AsyncIterator[OpsBatch]:
        frame_id = self._next_frame_id()
        self._open_frame_id = frame_id
        self._open_text = ""
        ops: list[EmittableOperation] = [
            FrameUpsertOp(
                turn_id=self.turn_id,
                step_id=self._step_id,
                frame=(
                    ThinkingFrame(frame_id=frame_id, text="")
                    if thinking
                    else TextFrame(frame_id=frame_id, role="assistant", text="")
                ),
            )
        ]
        ops.extend(self._append_ops(initial))
        yield tuple(ops)

    async def _append(self, text: str) -> AsyncIterator[OpsBatch]:
        ops = self._append_ops(text)
        if ops:
            yield tuple(ops)

    def _append_ops(self, text: str) -> list[EmittableOperation]:
        if not text or self._open_frame_id is None:
            return []
        op = AppendOp(
            target=FrameTarget(
                turn_id=self.turn_id, step_id=self._step_id, frame_id=self._open_frame_id
            ),
            offset=utf16_len(self._open_text),
            text=text,
        )
        self._open_text += text
        return [op]

    async def _flush(self, frame: type[Any], **extra: Any) -> AsyncIterator[OpsBatch]:
        if self._open_frame_id is None:
            return
        frame_id, text = self._open_frame_id, self._open_text
        self._open_frame_id = None
        self._open_text = ""
        yield (
            FrameUpsertOp(
                turn_id=self.turn_id,
                step_id=self._step_id,
                frame=frame(frame_id=frame_id, text=text, **extra),
            ),
        )


def step_responses(messages: Sequence[ModelMessage], run_id: str | None) -> list[ModelResponse]:
    recorded = recorded_loads(messages)
    return [
        message
        for message in messages
        if isinstance(message, ModelResponse)
        and not compaction_only(message, recorded)
        and (run_id is None or message.run_id == run_id)
    ]


def _prompt_content(part: UserPromptPart) -> tuple[PromptContent, ...]:
    items = [part.content] if isinstance(part.content, str) else list(part.content)
    return prompt_content(items)


def _approvals(results: DeferredToolResults) -> list[tuple[str, bool]]:
    return [
        (call_id, decision if isinstance(decision, bool) else not isinstance(decision, ToolDenied))
        for call_id, decision in results.approvals.items()
    ]


__all__ = ["OpsBatch", "TranscriptEventStream", "step_responses"]
