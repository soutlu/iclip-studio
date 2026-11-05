from __future__ import annotations

from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Final, Literal, cast

from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    TextPart,
    ThinkingPart,
    ThinkingPartDelta,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai.usage import RequestUsage
from pydantic_ai_harness.step_persistence import StepEvent

from agent_runtime.harness.background import (
    BackgroundOutcome,
    is_receipt,
    parse_outcome,
    was_receipt,
)
from agent_runtime.harness.context_compaction import (
    compacted_by,
    compaction_boundary,
    compaction_only,
    recorded_load_call,
    recorded_loads,
)
from agent_runtime.harness.job_status import JobStatus
from agent_runtime.harness.transcript.prompt_media import plain_text, prompt_content
from agent_runtime.transcript.display import GenericDisplay, ToolDisplayRegistry
from agent_runtime.transcript.ops import (
    APPROVAL_ID_PREFIX,
    COMPACTION_NOTICE,
    TOOL_STATE_BY_OUTCOME,
    AgentRef,
    Interaction,
    NoticeFrame,
    PromptContent,
    StepUsage,
    TaskState,
    TextContent,
    TextFrame,
    ThinkingFrame,
    ToolFrame,
    TranscriptFrame,
    TranscriptStep,
    TranscriptTask,
    TranscriptTurn,
    TurnOrigin,
    TurnUsage,
    next_frame_ordinal,
)

TurnState = Literal["queued", "running", "completed", "failed", "cancelled"]

ApprovalState = Literal["pending", "approved", "rejected", "cancelled"]

_ENDED_STATES: Final = ("completed", "failed", "cancelled")


@dataclass(frozen=True, slots=True)
class SteeredPrompt:
    prompt_id: str
    run_id: str | None
    content: tuple[PromptContent, ...]


_Steer = tuple[tuple[PromptContent, ...], tuple[str, ...] | None]

_CLOSED_OUT_OUTCOMES: Final = ("failed", "interrupted")

_WAITING_PROMPT_STATUSES: Final[tuple[JobStatus, ...]] = ("awaiting", "running")

_TURN_STATE_BY_PROMPT: Final[dict[JobStatus, TurnState]] = {
    "awaiting": "running",
    "running": "running",
    "aborted": "cancelled",
    "failed": "failed",
}


def turns_from_messages(
    messages: Sequence[ModelMessage],
    *,
    turn_states: Mapping[str, TurnState] | None = None,
    turn_errors: Mapping[str, str | None] | None = None,
    prompt_of_run: Mapping[str, str] | None = None,
    prompt_status_of_run: Mapping[str, JobStatus] | None = None,
    subagent_of_call: Mapping[str, str] | None = None,
    steered: Sequence[SteeredPrompt] = (),
    display: ToolDisplayRegistry = ToolDisplayRegistry.EMPTY,
) -> tuple[TranscriptTurn, ...]:
    states = turn_states or {}
    errors = turn_errors or {}
    statuses = prompt_status_of_run or {}
    of_run = prompt_of_run or {}
    recorded = recorded_loads(messages)
    pending: list[_PendingCompaction] = []
    turns: list[TranscriptTurn] = []
    for ordinal, segments in enumerate(_group_by_turn(messages, of_run), start=1):
        last_run = segments[-1][0]
        settled, waiting = _approval_calls(segments, states)
        prompt_status = statuses.get(last_run)
        from_events = states.get(last_run, "failed")
        turns.append(
            _turn(
                segments,
                ordinal=ordinal,
                state=(
                    _TURN_STATE_BY_PROMPT.get(prompt_status, from_events)
                    if waiting and prompt_status is not None
                    else from_events
                ),
                error=errors.get(last_run),
                run_states=states,
                approvals=(*settled, *waiting),
                waiting=waiting if prompt_status in _WAITING_PROMPT_STATUSES else (),
                subagent_of_call=subagent_of_call or {},
                prompt_id=of_run.get(segments[0][0]),
                steered=steered,
                display=display,
                recorded=recorded,
                pending=pending,
            )
        )
    return tuple(turns)


@dataclass(frozen=True, slots=True)
class _PendingCompaction:
    at: datetime
    run_id: str | None
    summary: str | None
    loads: tuple[ToolCallPart, ...]


@dataclass(frozen=True, slots=True)
class ChildRun:
    run_id: str
    agent_name: str | None
    started_at: datetime
    ended_at: datetime | None
    state: TurnState
    model: str | None = None
    thinking_effort: str | None = None


_TASK_STATE_BY_RUN: Final[dict[TurnState, TaskState]] = {
    "completed": "completed",
    "cancelled": "killed",
}


def tasks_from_messages(
    messages: Sequence[ModelMessage],
    *,
    subagent_of_call: Mapping[str, str],
    child_runs: Sequence[ChildRun],
    run_states: Mapping[str, TurnState] | None = None,
    display: ToolDisplayRegistry = ToolDisplayRegistry.EMPTY,
) -> tuple[TranscriptTask, ...]:
    call_of_child = {child_id: call_id for call_id, child_id in subagent_of_call.items()}
    returns = _tool_returns(messages)
    tasks: list[TranscriptTask] = []
    for child in sorted(child_runs, key=lambda item: item.started_at):
        summary, error = returns.get(call_of_child.get(child.run_id, ""), (None, None))
        tasks.append(
            TranscriptTask(
                task_id=child.run_id,
                kind="subagent",
                state=_TASK_STATE_BY_RUN.get(child.state, "failed"),
                detached=False,
                description=child.agent_name,
                agent_id=child.run_id,
                started_at=_iso(child.started_at),
                ended_at=_iso(child.ended_at),
                result_summary=summary,
                error=error,
                model=child.model,
                thinking_effort=child.thinking_effort,
            )
        )
    tasks.extend(_background_tasks(messages, run_states or {}, display))
    return tuple(tasks)


def _background_tasks(
    messages: Sequence[ModelMessage],
    run_states: Mapping[str, TurnState],
    display: ToolDisplayRegistry,
) -> list[TranscriptTask]:
    calls = {
        part.tool_call_id: part
        for message in messages
        if isinstance(message, ModelResponse)
        for part in message.parts
        if isinstance(part, ToolCallPart)
    }
    outcomes = {
        outcome.tool_call_id: (outcome, part.timestamp)
        for message in messages
        if isinstance(message, ModelRequest)
        for part in message.parts
        if isinstance(part, UserPromptPart)
        if (outcome := parse_outcome(part)) is not None
    }
    tasks: list[TranscriptTask] = []
    for run_id, group in _group_by_run(messages):
        paused = run_states.get(run_id) == "completed" and bool(unanswered_tool_calls(group))
        for message in group:
            if not isinstance(message, ModelRequest):
                continue
            for part in message.parts:
                if not isinstance(part, ToolReturnPart):
                    continue
                if not is_receipt(part) and not was_receipt(part):
                    continue
                call = calls.get(part.tool_call_id)
                if call is None:
                    continue
                task = background_task(
                    _call_card(call, step_id="", display=display), started_at=_iso(part.timestamp)
                )
                delivered = outcomes.get(part.tool_call_id)
                if delivered is not None:
                    outcome, at = delivered
                    tasks.append(settle_background_task(task, outcome, ended_at=_iso(at)))
                    continue
                state = interrupted_task_state(
                    run_states.get(run_id, "failed"), paused_for_approval=paused
                )
                ended_at = _iso(_ended_at(group) or part.timestamp)
                tasks.append(task.model_copy(update={"state": state, "ended_at": ended_at}))
    return tasks


def card_title(card: ToolFrame) -> str:
    display = card.display
    if isinstance(display, GenericDisplay):
        return " ".join(item for item in (display.summary, display.detail) if item)
    return card.name


def background_task(card: ToolFrame, *, started_at: str | None) -> TranscriptTask:
    return TranscriptTask(
        task_id=card.tool_call_id,
        kind="tool",
        state="running",
        detached=True,
        description=card_title(card),
        started_at=started_at,
    )


def background_notice(card: ToolFrame, outcome: BackgroundOutcome, *, frame_id: str) -> TextFrame:
    title = card_title(card)
    text = f"已{title}" if outcome.state == "done" else f"{title} 失败"
    return TextFrame(
        frame_id=frame_id,
        role="user",
        text=text,
        content=(TextContent(text=text),),
        task_id=card.tool_call_id,
    )


def settle_background_task(
    task: TranscriptTask, outcome: BackgroundOutcome, *, ended_at: str | None
) -> TranscriptTask:
    done = outcome.state == "done"
    return task.model_copy(
        update={
            "state": "completed" if done else "failed",
            "ended_at": ended_at,
            "result_summary": outcome.text if done else None,
            "error": None if done else outcome.text,
        }
    )


def interrupted_task_state(run_state: TurnState, *, paused_for_approval: bool) -> TaskState:
    if run_state == "cancelled" or paused_for_approval:
        return "killed"
    return "failed"


def _tool_returns(
    messages: Sequence[ModelMessage],
) -> dict[str, tuple[str | None, str | None]]:
    found: dict[str, tuple[str | None, str | None]] = {}
    for message in messages:
        if not isinstance(message, ModelRequest):
            continue
        for part in message.parts:
            if not isinstance(part, ToolReturnPart):
                continue
            state, output, _, error = settle_tool_return(part)
            stopped = part.outcome == "interrupted"
            found[part.tool_call_id] = (
                str(output) if state == "done" else None,
                None if state == "done" or stopped else error,
            )
    return found


def approvals_from_messages(
    messages: Sequence[ModelMessage],
    *,
    turn_states: Mapping[str, TurnState] | None = None,
    prompt_of_run: Mapping[str, str] | None = None,
    prompt_status_of_run: Mapping[str, JobStatus] | None = None,
) -> tuple[Interaction, ...]:
    states = turn_states or {}
    statuses = prompt_status_of_run or {}
    items: list[Interaction] = []
    for segments in _group_by_turn(messages, prompt_of_run or {}):
        settled, waiting = _approval_calls(segments, states)
        items.extend(_approval(item, state) for item, state in settled.items())
        pending = statuses.get(segments[-1][0]) in _WAITING_PROMPT_STATUSES
        items.extend(_approval(item, "pending" if pending else "cancelled") for item in waiting)
    return tuple(items)


def _approval(tool_call_id: str, state: ApprovalState) -> Interaction:
    return Interaction(
        interaction_id=f"{APPROVAL_ID_PREFIX}{tool_call_id}",
        interaction_kind="approval",
        tool_call_id=tool_call_id,
        state=state,
    )


def _approval_calls(
    segments: Sequence[tuple[str, Sequence[ModelMessage]]],
    run_states: Mapping[str, TurnState],
) -> tuple[dict[str, ApprovalState], tuple[str, ...]]:
    settled: dict[str, ApprovalState] = {}
    open_calls: tuple[str, ...] = ()
    for index, (run_id, group) in enumerate(segments):
        first = group[0] if group else None
        if index > 0 and open_calls and isinstance(first, ModelRequest):
            for part in first.parts:
                if not isinstance(part, ToolReturnPart) or part.tool_call_id not in open_calls:
                    continue
                if part.outcome in _CLOSED_OUT_OUTCOMES:
                    continue
                settled[part.tool_call_id] = "rejected" if part.outcome == "denied" else "approved"
        open_calls = unanswered_tool_calls(group) if run_states.get(run_id) == "completed" else ()
    return settled, open_calls


def run_ids_from_messages(messages: Sequence[ModelMessage]) -> tuple[str, ...]:
    return tuple(run_id for run_id, _ in _group_by_run(messages))


def turn_run_ids(
    messages: Sequence[ModelMessage], prompt_of_run: Mapping[str, str]
) -> tuple[tuple[str, ...], ...]:
    return tuple(
        tuple(run_id for run_id, _ in segments)
        for segments in _group_by_turn(messages, prompt_of_run)
    )


def drop_last_turn(
    messages: Sequence[ModelMessage], prompt_of_run: Mapping[str, str]
) -> tuple[list[ModelMessage], tuple[str, ...]]:
    turns = _group_by_turn(messages, prompt_of_run)
    if not turns:
        return [], ()
    kept = [message for segments in turns[:-1] for _, group in segments for message in group]
    return kept, tuple(run_id for run_id, _ in turns[-1])


def keep_turns(
    messages: Sequence[ModelMessage], prompt_of_run: Mapping[str, str], *, ordinal: int
) -> list[ModelMessage]:
    turns = _group_by_turn(messages, prompt_of_run)
    return [message for segments in turns[:ordinal] for _, group in segments for message in group]


def run_state_from_events(events: Sequence[StepEvent]) -> TurnState:
    for event in reversed(events):
        if event.kind == "run_completed":
            return "completed"
        if event.kind == "run_failed":
            error = event.error or ""
            return "cancelled" if error.startswith(("RunCancelled", "CancelledError")) else "failed"
    return "failed"


def run_error_from_events(events: Sequence[StepEvent]) -> str | None:
    for event in reversed(events):
        if event.kind == "run_completed":
            return None
        if event.kind == "run_failed":
            return event.error
    return None


def _group_by_turn(
    messages: Sequence[ModelMessage], prompt_of_run: Mapping[str, str]
) -> list[list[tuple[str, list[ModelMessage]]]]:
    turns: list[list[tuple[str, list[ModelMessage]]]] = []
    for run_id, group in _group_by_run(messages):
        prompt_id = prompt_of_run.get(run_id)
        if turns and prompt_id is not None and prompt_of_run.get(turns[-1][-1][0]) == prompt_id:
            turns[-1].append((run_id, group))
        else:
            turns.append([(run_id, group)])
    return turns


def _group_by_run(messages: Sequence[ModelMessage]) -> list[tuple[str, list[ModelMessage]]]:
    grouped: dict[str, list[ModelMessage]] = {}
    current = ""
    for message in messages:
        current = message.run_id or current
        grouped.setdefault(current, []).append(message)
    recorded = recorded_loads(messages)
    return sorted(grouped.items(), key=lambda item: _started_at(item[1], recorded))


_EPOCH = datetime.min.replace(tzinfo=UTC)


def _started_at(group: Sequence[ModelMessage], recorded: Collection[str]) -> datetime:
    return next(
        (
            at
            for message in group
            if not compaction_only(message, recorded)
            if (at := _at(message)) is not None
        ),
        _EPOCH,
    )


def _ended_at(group: Sequence[ModelMessage]) -> datetime | None:
    return next((at for message in reversed(group) if (at := _at(message)) is not None), None)


def _at(message: ModelMessage) -> datetime | None:
    return message.timestamp


def _iso(moment: datetime | None) -> str | None:
    return None if moment is None else moment.isoformat()


def _turn(
    segments: Sequence[tuple[str, Sequence[ModelMessage]]],
    *,
    ordinal: int,
    state: TurnState,
    error: str | None = None,
    run_states: Mapping[str, TurnState],
    subagent_of_call: Mapping[str, str],
    approvals: Sequence[str] = (),
    waiting: Sequence[str] = (),
    prompt_id: str | None = None,
    steered: Sequence[SteeredPrompt] = (),
    display: ToolDisplayRegistry = ToolDisplayRegistry.EMPTY,
    recorded: Mapping[str, ToolReturnPart],
    pending: list[_PendingCompaction],
) -> TranscriptTurn:
    turn_id = f"t{ordinal}"
    steps: list[TranscriptStep] = []
    tool_frames: dict[str, str] = {}
    frames_by_step: list[dict[str, TranscriptFrame]] = []
    content: tuple[PromptContent, ...] | None = None
    pending_request: ModelRequest | None = None
    pending_steers: list[_Steer] = []
    awaiting_outcome: set[str] = set()
    turn_runs = {run_id for run_id, _ in segments}
    unclaimed = [row for row in steered if row.run_id in turn_runs]

    for index, (run_id, group) in enumerate(segments):
        opened = len(steps)
        for message in group:
            if isinstance(message, ModelResponse):
                boundary = compaction_boundary(message)
                loads = tuple(part for part in message.parts if recorded_load_call(part, recorded))
                if boundary is not None or loads:
                    pending.append(
                        _PendingCompaction(
                            at=message.timestamp,
                            run_id=compacted_by(message),
                            summary=None if boundary is None else boundary.content or "",
                            loads=loads,
                        )
                    )
            if compaction_only(message, recorded):
                continue
            if isinstance(message, ModelRequest):
                _settle_tools(message, tool_frames, frames_by_step, awaiting_outcome)
                if content is None and (said := _user_content(message)):
                    content = said
                else:
                    for part in message.parts:
                        if not isinstance(part, UserPromptPart):
                            continue
                        outcome = parse_outcome(part)
                        if outcome is not None:
                            awaiting_outcome.discard(outcome.tool_call_id)
                            _notice_frame(outcome, steps, tool_frames, frames_by_step, turn_id)
                        elif not (said := _part_content(part)):
                            continue
                        elif steps:
                            step_index = len(steps) - 1
                            _user_frame(
                                frames_by_step[step_index],
                                f"{turn_id}.{step_index + 1}",
                                said,
                                _claim(unclaimed, said),
                            )
                        else:
                            pending_steers.append((said, _claim(unclaimed, said)))
                pending_request = message
                continue

            step_ordinal = len(steps) + 1
            step_id = f"{turn_id}.{step_ordinal}"
            frames: dict[str, TranscriptFrame] = {}
            frames_by_step.append(frames)
            later: list[_PendingCompaction] = []
            for item in pending:
                if item.at >= message.timestamp or item.run_id not in (None, run_id):
                    later.append(item)
                    continue
                if item.summary is not None:
                    _compaction_frame(frames, step_id, item.summary)
                for call in item.loads:
                    card = recorded_load_card(
                        call, recorded[call.tool_call_id], step_id=step_id, display=display
                    )
                    frames[card.frame_id] = card
            pending[:] = later
            for said, prompt_ids in pending_steers:
                _user_frame(frames, step_id, said, prompt_ids)
            pending_steers.clear()
            _open_frames(
                message,
                step_id=step_id,
                frames=frames,
                tool_frames=tool_frames,
                subagent_of_call=subagent_of_call,
                display=display,
                recorded=recorded,
            )
            steps.append(
                TranscriptStep(
                    step_id=step_id,
                    turn_id=turn_id,
                    ordinal=step_ordinal,
                    state="completed",
                    started_at=_iso(None if pending_request is None else pending_request.timestamp),
                    ended_at=_iso(message.timestamp),
                    usage=step_usage(message.usage),
                    finish_reason=message.finish_reason,
                )
            )

        broke_off = (
            index < len(segments) - 1
            and len(steps) > opened
            and run_states.get(run_id, "failed") != "completed"
        )
        if broke_off:
            steps[-1] = steps[-1].model_copy(update={"state": "interrupted"})

    for tool_call_id in approvals:
        _stamp_approval(tool_call_id, tool_frames, frames_by_step)
    _close_orphan_tools(
        tool_frames, frames_by_step, keep_open=waiting, awaiting_outcome=awaiting_outcome
    )
    pending[:] = [item for item in pending if item.run_id is not None]

    messages = [message for _, group in segments for message in group]
    started, ended = _started_at(messages, recorded), _ended_at(messages)
    return TranscriptTurn(
        turn_id=turn_id,
        trigger_prompt_id=prompt_id,
        ordinal=ordinal,
        state=state,
        origin=TurnOrigin(kind="user"),
        content=content or (),
        started_at=_iso(started),
        ended_at=_iso(ended) if state in _ENDED_STATES else None,
        usage=turn_usage([step.usage for step in steps if step.usage is not None]),
        duration_ms=_duration_ms(started, ended) if state in _ENDED_STATES else None,
        error=error,
        steps=tuple(
            step.model_copy(update={"frames": tuple(frames_by_step[index].values())})
            for index, step in enumerate(steps)
        ),
    )


def _compaction_frame(frames: dict[str, TranscriptFrame], step_id: str, summary: str) -> None:
    frame_id = f"{step_id}.compaction"
    frames[frame_id] = NoticeFrame(
        frame_id=frame_id, level="info", message=COMPACTION_NOTICE, detail=summary
    )


def _user_frame(
    frames: dict[str, TranscriptFrame],
    step_id: str,
    content: tuple[PromptContent, ...],
    prompt_ids: tuple[str, ...] | None,
) -> None:
    frame_id = f"{step_id}.f{next_frame_ordinal(frames)}"
    frames[frame_id] = TextFrame(
        frame_id=frame_id,
        role="user",
        text=plain_text(content),
        content=content,
        prompt_ids=prompt_ids,
    )


def _notice_frame(
    outcome: BackgroundOutcome,
    steps: Sequence[TranscriptStep],
    tool_frames: dict[str, str],
    frames_by_step: list[dict[str, TranscriptFrame]],
    turn_id: str,
) -> None:
    card = _find_tool(outcome.tool_call_id, tool_frames, frames_by_step)
    if card is None or not steps:
        return
    frames = frames_by_step[len(steps) - 1]
    frame_id = f"{turn_id}.{len(steps)}.f{next_frame_ordinal(frames)}"
    frames[frame_id] = background_notice(card, outcome, frame_id=frame_id)


def _claim(
    unclaimed: list[SteeredPrompt], content: tuple[PromptContent, ...]
) -> tuple[str, ...] | None:
    for index, row in enumerate(unclaimed):
        if row.content == content:
            del unclaimed[index]
            return (row.prompt_id,)
    return None


def _duration_ms(started: datetime, ended: datetime | None) -> int | None:
    if ended is None or started == _EPOCH:
        return None
    return int((ended - started).total_seconds() * 1000)


def _user_content(message: ModelRequest) -> tuple[PromptContent, ...]:
    parts: list[PromptContent] = []
    for part in message.parts:
        if not isinstance(part, UserPromptPart) or parse_outcome(part) is not None:
            continue
        parts.extend(_part_content(part))
    return tuple(parts)


def _part_content(part: UserPromptPart) -> tuple[PromptContent, ...]:
    items = [part.content] if isinstance(part.content, str) else list(part.content)
    return prompt_content(items)


def thinking_text(part: ThinkingPart) -> str:
    if part.content:
        return part.content
    return _joined_raw_content(part.provider_details)


def thinking_delta_text(delta: ThinkingPartDelta) -> str:
    if delta.content_delta:
        return delta.content_delta
    if callable(delta.provider_details):
        return _joined_raw_content(delta.provider_details(None))
    return ""


def _joined_raw_content(details: Mapping[str, Any] | None) -> str:
    raw = None if details is None else details.get("raw_content")
    return "".join(cast("list[str]", raw)) if raw else ""


def _open_frames(
    message: ModelResponse,
    *,
    step_id: str,
    frames: dict[str, TranscriptFrame],
    tool_frames: dict[str, str],
    subagent_of_call: Mapping[str, str],
    display: ToolDisplayRegistry,
    recorded: Collection[str],
) -> None:
    for part in message.parts:
        if recorded_load_call(part, recorded):
            continue
        if isinstance(part, ThinkingPart):
            frame_id = f"{step_id}.f{next_frame_ordinal(frames)}"
            frames[frame_id] = ThinkingFrame(frame_id=frame_id, text=thinking_text(part))
        elif isinstance(part, TextPart):
            frame_id = f"{step_id}.f{next_frame_ordinal(frames)}"
            frames[frame_id] = TextFrame(frame_id=frame_id, role="assistant", text=part.content)
        elif isinstance(part, ToolCallPart):
            child_id = subagent_of_call.get(part.tool_call_id)
            card = _call_card(part, step_id=step_id, display=display, child_id=child_id)
            frames[card.frame_id] = card
            tool_frames[part.tool_call_id] = card.frame_id


def _call_card(
    part: ToolCallPart, *, step_id: str, display: ToolDisplayRegistry, child_id: str | None = None
) -> ToolFrame:
    return ToolFrame(
        frame_id=f"{step_id}.{part.tool_call_id}",
        tool_call_id=part.tool_call_id,
        name=part.tool_name,
        state="running",
        input=part.args,
        display=display.tool_display(part.tool_name, part.args),
        view=display.view_of(part.tool_name),
        agent_refs=None if child_id is None else (AgentRef(agent_id=child_id, role="child"),),
    )


def recorded_load_card(
    call: ToolCallPart, returned: ToolReturnPart, *, step_id: str, display: ToolDisplayRegistry
) -> ToolFrame:
    state, output, metadata, error = settle_tool_return(returned)
    return _call_card(call, step_id=step_id, display=display).model_copy(
        update={"state": state, "output": output, "metadata": metadata, "error": error}
    )


def _settle_tools(
    message: ModelRequest,
    tool_frames: dict[str, str],
    frames_by_step: list[dict[str, TranscriptFrame]],
    awaiting_outcome: set[str],
) -> None:
    for part in message.parts:
        if not isinstance(part, ToolReturnPart):
            continue
        if is_receipt(part):
            awaiting_outcome.add(part.tool_call_id)
        state, output, metadata, error = settle_tool_return(part)
        _replace_tool(
            part.tool_call_id,
            tool_frames,
            frames_by_step,
            state=state,
            output=output,
            metadata=metadata,
            error=error,
        )


def unanswered_tool_calls(messages: Sequence[ModelMessage]) -> tuple[str, ...]:
    last = next(
        (
            index
            for index in range(len(messages) - 1, -1, -1)
            if isinstance(messages[index], ModelResponse)
        ),
        None,
    )
    if last is None:
        return ()
    response = cast("ModelResponse", messages[last])
    called = [part.tool_call_id for part in response.parts if isinstance(part, ToolCallPart)]
    answered = {
        part.tool_call_id
        for message in messages[last + 1 :]
        for part in message.parts
        if isinstance(part, ToolReturnPart)
    }
    return tuple(item for item in called if item not in answered)


ORPHAN_TOOL_ERROR = "运行中断，这次调用没有结果"


def settle_tool_return(
    part: ToolReturnPart,
) -> tuple[Literal["done", "error"], object, object, str | None]:
    if part.outcome == "interrupted":
        return "error", None, None, ORPHAN_TOOL_ERROR
    state = TOOL_STATE_BY_OUTCOME.get(part.outcome, "error")
    return state, part.content, part.metadata, None if state == "done" else str(part.content)


def _stamp_approval(
    tool_call_id: str,
    tool_frames: dict[str, str],
    frames_by_step: list[dict[str, TranscriptFrame]],
) -> None:
    frame_id = tool_frames.get(tool_call_id)
    if frame_id is None:
        return
    for step_frames in frames_by_step:
        existing = step_frames.get(frame_id)
        if isinstance(existing, ToolFrame):
            step_frames[frame_id] = existing.model_copy(
                update={"approval_id": f"{APPROVAL_ID_PREFIX}{tool_call_id}"}
            )
            return


def _close_orphan_tools(
    tool_frames: dict[str, str],
    frames_by_step: list[dict[str, TranscriptFrame]],
    *,
    keep_open: Sequence[str] = (),
    awaiting_outcome: Collection[str] = (),
) -> None:
    for tool_call_id in tool_frames:
        if tool_call_id in keep_open:
            continue
        for step_frames in frames_by_step:
            existing = step_frames.get(tool_frames[tool_call_id])
            if isinstance(existing, ToolFrame) and (
                existing.state == "running" or tool_call_id in awaiting_outcome
            ):
                _replace_tool(
                    tool_call_id,
                    tool_frames,
                    frames_by_step,
                    state="error",
                    output=None,
                    metadata=None,
                    error=ORPHAN_TOOL_ERROR,
                )
                break


def _find_tool(
    tool_call_id: str,
    tool_frames: dict[str, str],
    frames_by_step: list[dict[str, TranscriptFrame]],
) -> ToolFrame | None:
    frame_id = tool_frames.get(tool_call_id)
    if frame_id is None:
        return None
    for step_frames in frames_by_step:
        existing = step_frames.get(frame_id)
        if isinstance(existing, ToolFrame):
            return existing
    return None


def _replace_tool(
    tool_call_id: str,
    tool_frames: dict[str, str],
    frames_by_step: list[dict[str, TranscriptFrame]],
    *,
    state: Literal["done", "error"],
    output: object,
    metadata: object,
    error: str | None,
) -> None:
    frame_id = tool_frames.get(tool_call_id)
    if frame_id is None:
        return
    for step_frames in frames_by_step:
        existing = step_frames.get(frame_id)
        if isinstance(existing, ToolFrame):
            step_frames[frame_id] = existing.model_copy(
                update={"state": state, "output": output, "metadata": metadata, "error": error}
            )
            return


def step_usage(usage: RequestUsage | None) -> StepUsage | None:
    if usage is None:
        return None
    return StepUsage(
        input_other=usage.input_tokens - usage.cache_read_tokens - usage.cache_write_tokens,
        output=usage.output_tokens,
        input_cache_read=usage.cache_read_tokens,
        input_cache_creation=usage.cache_write_tokens,
    )


def turn_usage(steps: Sequence[StepUsage]) -> TurnUsage | None:
    if not steps:
        return None
    return TurnUsage(
        input_tokens=sum(item.input_other + item.input_cache_creation for item in steps),
        cached_tokens=sum(item.input_cache_read for item in steps),
        output_tokens=sum(item.output for item in steps),
    )


__all__ = [
    "ORPHAN_TOOL_ERROR",
    "ApprovalState",
    "ChildRun",
    "SteeredPrompt",
    "TurnState",
    "approvals_from_messages",
    "background_notice",
    "background_task",
    "card_title",
    "drop_last_turn",
    "interrupted_task_state",
    "keep_turns",
    "recorded_load_card",
    "run_error_from_events",
    "run_ids_from_messages",
    "run_state_from_events",
    "settle_background_task",
    "settle_tool_return",
    "step_usage",
    "tasks_from_messages",
    "thinking_delta_text",
    "thinking_text",
    "turn_run_ids",
    "turn_usage",
    "turns_from_messages",
    "unanswered_tool_calls",
]
