"""从持久化消息重建 transcript，结构须与实时投影一致。

同一 prompt 的全部 run 合并为一轮，无映射的 run 各自成轮，按首条消息时间排序。
终态与错误来自持久化结束事件；缺少结束事件时标记失败。
末尾开放的审批调用结合 prompt 当前状态判定，见 _approval_calls。
"""

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

from iclip.harness.background import BackgroundOutcome, is_receipt, parse_outcome, was_receipt
from iclip.harness.context_compaction import (
    compacted_by,
    compaction_boundary,
    compaction_only,
    recorded_load_call,
    recorded_loads,
)
from iclip.harness.job_status import JobStatus
from iclip.harness.transcript.prompt_media import plain_text, prompt_content
from iclip.platform.transcript.display import GenericDisplay, ToolDisplayRegistry
from iclip.platform.transcript.ops import (
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
"""轮到了这几个状态才有耗时；running 与等审批的轮没有。"""


@dataclass(frozen=True, slots=True)
class SteeredPrompt:
    """一条插过话的消息；历史重建时按轮内顺序与内容把它对回插话块。"""

    prompt_id: str
    run_id: str | None
    content: tuple[PromptContent, ...]


_Steer = tuple[tuple[PromptContent, ...], tuple[str, ...] | None]
"""一条插话：内容，以及它来自哪条消息（对不上时为 None）。"""

_CLOSED_OUT_OUTCOMES: Final = ("failed", "interrupted")
"""系统补全的失败结果：新消息关闭旧调用使用 failed，中断恢复使用 interrupted。"""

_WAITING_PROMPT_STATUSES: Final[tuple[JobStatus, ...]] = ("awaiting", "running")
"""审批仍可被处理的状态：等待审批或已开始续跑。"""

_TURN_STATE_BY_PROMPT: Final[dict[JobStatus, TurnState]] = {
    "awaiting": "running",
    "running": "running",
    "aborted": "cancelled",
    "failed": "failed",
}
"""存在开放审批调用时，按 prompt 状态决定轮次终态；run_completed 不代表审批已完成。"""


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
    """按时间重建轮次；同 prompt 的 run 合并，轮次终态取最后一次 run。

    turn_states/turn_errors 按 run_id 提供，prompt_status_of_run 用于开放审批调用。
    subagent_of_call 把 toolCallId 映射到它派出的子代理 id，据此给工具卡补 agentRefs。
    steered 是本对话插过话的消息（按插话先后），插话块靠它标 promptIds。
    display 须与实时投影共享，保持工具卡结构一致。
    """

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
    """一次压缩留在历史里、待挂到步骤上的显示：压缩提示，或补记的加载卡。"""

    at: datetime
    """边界或补记的写入时间；只挂到时间严格晚于它的步骤。"""
    run_id: str | None
    """执行压缩的 run；早先的边界没有记录，只在所在轮内找步。"""
    summary: str | None
    loads: tuple[ToolCallPart, ...]


@dataclass(frozen=True, slots=True)
class ChildRun:
    """一次子代理运行的持久事实，由 history 层从运行记录与结束事件读出。"""

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
"""子运行终态到任务终态；其余（含未收尾）一律 failed。"""


def tasks_from_messages(
    messages: Sequence[ModelMessage],
    *,
    subagent_of_call: Mapping[str, str],
    child_runs: Sequence[ChildRun],
    run_states: Mapping[str, TurnState] | None = None,
    display: ToolDisplayRegistry = ToolDisplayRegistry.EMPTY,
) -> tuple[TranscriptTask, ...]:
    """把子运行重建成 subagent 任务，把后台工具调用重建成 tool 任务。

    subagent 任务的结果与错误取父侧那次 delegate_task 的返回；父侧返回找不到（子运行中途崩、
    账本没写上）时结果与错误都留空。tool 任务见 _background_tasks；run_states 按 run_id 给出
    运行终态，display 须与实时投影共享，任务描述才一致。
    """

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
    """每条回执开一条 tool 任务，结果递入时按结果收尾。

    回执之后没有递入结果的，它所在的运行已不再存活（实时侧还活着的会盖掉这一份）：终态按发起
    它的那次运行定（interrupted_task_state，审批暂停只看那次运行自己那一组），结束时间取那次运行的
    最后一条消息。后续运行开跑时回执已被换成带标记的 interrupted 返回（was_receipt），按同一规则处理，
    它保留着回执的时间戳与所在运行。
    """

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
    """工具卡的标题：generic display 的 summary 与 detail 用空格连接，其余退回工具名。

    后台任务的描述与完成通知的文字都由它来，两条投影共用。
    """

    display = card.display
    if isinstance(display, GenericDisplay):
        return " ".join(item for item in (display.summary, display.detail) if item)
    return card.name


def background_task(card: ToolFrame, *, started_at: str | None) -> TranscriptTask:
    """回执到达时为这次后台调用开的任务：id 是调用 id，描述是卡标题。"""

    return TranscriptTask(
        task_id=card.tool_call_id,
        kind="tool",
        state="running",
        detached=True,
        description=card_title(card),
        started_at=started_at,
    )


def background_notice(card: ToolFrame, outcome: BackgroundOutcome, *, frame_id: str) -> TextFrame:
    """后台结果递入时插在到达处的完成通知：成功「已{标题}」，失败「{标题} 失败」。

    它是 role user 的块，带 task_id 与前端区分用户的话；content 只有一段相同的文字。
    """

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
    """按递入的结果收尾任务：成功写结果文本，失败写错误文本，与 subagent 任务同一约定。"""

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
    """回执之后没等到结果、运行已不再存活时任务的终态。

    被停与审批暂停是 killed（暂停会丢掉没跑完的后台调用），其余（失败、崩溃、运行结束仍没结果）
    是 failed。
    """

    if run_state == "cancelled" or paused_for_approval:
        return "killed"
    return "failed"


def _tool_returns(
    messages: Sequence[ModelMessage],
) -> dict[str, tuple[str | None, str | None]]:
    """按 toolCallId 收集工具返回给任务的（结果摘要, 错误），与实时投影同一口径。

    工具卡字段取自 settle_tool_return；被停（interrupted）的调用不带错误文本。
    """

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
    """重建审批交互；等待审批和续跑中的调用为 pending，撤回或失败的调用为 cancelled。"""

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
    """识别正常完成的 run 末尾无结果的调用作为审批。

    结果取同轮后续 run 的返回：denied 为拒绝，其余为放行；系统补全的 failed/interrupted 排除。
    """

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
    """按顺序返回运行 id，供查询结束事件。"""

    return tuple(run_id for run_id, _ in _group_by_run(messages))


def turn_run_ids(
    messages: Sequence[ModelMessage], prompt_of_run: Mapping[str, str]
) -> tuple[tuple[str, ...], ...]:
    """按轮序返回 run 分组，列表长度用于确定轮号。"""

    return tuple(
        tuple(run_id for run_id, _ in segments)
        for segments in _group_by_turn(messages, prompt_of_run)
    )


def drop_last_turn(
    messages: Sequence[ModelMessage], prompt_of_run: Mapping[str, str]
) -> tuple[list[ModelMessage], tuple[str, ...]]:
    """移除末轮的全部 run 并返回其 id；保留消息的轮号不变，续跑复用末轮编号。"""

    turns = _group_by_turn(messages, prompt_of_run)
    if not turns:
        return [], ()
    kept = [message for segments in turns[:-1] for _, group in segments for message in group]
    return kept, tuple(run_id for run_id, _ in turns[-1])


def keep_turns(
    messages: Sequence[ModelMessage], prompt_of_run: Mapping[str, str], *, ordinal: int
) -> list[ModelMessage]:
    """只留下前 ``ordinal`` 轮的消息，轮内次序与 run_id 都不变。越界轮号由调用方先挡掉。

    压缩摘要边界不特殊处理：它落在某一轮里，跟着那一轮一起留或一起走，续跑的模型窗口
    与源对话在同一位置看到同一份摘要。
    """

    turns = _group_by_turn(messages, prompt_of_run)
    return [message for segments in turns[:ordinal] for _, group in segments for message in group]


def run_state_from_events(events: Sequence[StepEvent]) -> TurnState:
    """将持久化结束事件映射为终态。run_failed 按 RunCancelled/CancelledError 区分取消；缺事件视为失败。"""

    for event in reversed(events):
        if event.kind == "run_completed":
            return "completed"
        if event.kind == "run_failed":
            error = event.error or ""
            return "cancelled" if error.startswith(("RunCancelled", "CancelledError")) else "failed"
    return "failed"


def run_error_from_events(events: Sequence[StepEvent]) -> str | None:
    """读取失败事件的错误文本，与实时轮次的 error 保持一致。"""

    for event in reversed(events):
        if event.kind == "run_completed":
            return None
        if event.kind == "run_failed":
            return event.error
    return None


def _group_by_turn(
    messages: Sequence[ModelMessage], prompt_of_run: Mapping[str, str]
) -> list[list[tuple[str, list[ModelMessage]]]]:
    """仅合并属于同一 prompt 的相邻 run；无映射的历史 run 保持独立。"""

    turns: list[list[tuple[str, list[ModelMessage]]]] = []
    for run_id, group in _group_by_run(messages):
        prompt_id = prompt_of_run.get(run_id)
        if turns and prompt_id is not None and prompt_of_run.get(turns[-1][-1][0]) == prompt_id:
            turns[-1].append((run_id, group))
        else:
            turns.append([(run_id, group)])
    return turns


def _group_by_run(messages: Sequence[ModelMessage]) -> list[tuple[str, list[ModelMessage]]]:
    """按 run_id 分组，以组内首条有效消息的时间排序。"""

    grouped: dict[str, list[ModelMessage]] = {}
    current = ""
    for message in messages:
        # 缺少 run_id 的消息归入前一 run，避免产生无时间的额外轮次。
        current = message.run_id or current
        grouped.setdefault(current, []).append(message)
    recorded = recorded_loads(messages)
    return sorted(grouped.items(), key=lambda item: _started_at(item[1], recorded))


_EPOCH = datetime.min.replace(tzinfo=UTC)


def _started_at(group: Sequence[ModelMessage], recorded: Collection[str]) -> datetime:
    """取首个有效消息时间，排除压缩边界与补记的创建时间，避免改变原轮次顺序。"""

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
    """跨 run 连续编号步骤；工具卡保留在发起步骤，等待审批的卡保持 running。"""

    turn_id = f"t{ordinal}"
    steps: list[TranscriptStep] = []
    # 按 toolCallId 保留卡片位置，结果可能在后续 run 的首条请求中到达。
    tool_frames: dict[str, str] = {}
    frames_by_step: list[dict[str, TranscriptFrame]] = []
    content: tuple[PromptContent, ...] | None = None
    pending_request: ModelRequest | None = None
    pending_steers: list[_Steer] = []
    # 有回执、还没递入结果的后台调用；轮末仍在的按中断收卡。
    awaiting_outcome: set[str] = set()
    # 插话行按轮取而不按 run：续跑会把它们挪到新 run，消息却留在旧 run 的段里。
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
                    # 首条用户消息属于轮次输入，不另建块。
                    content = said
                else:
                    # 插话与后台结果按 part 顺序挂在当时的末步，与实时投影保持一致。
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
                            # 首步尚未创建时暂存插话，随后插入首步开头。
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

        # 未完成且后续有续跑的 run，其末步标记为中断。
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
    """压缩提示使用独立 id，不占 .f<n> 块序号。"""

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
    """将用户消息加入步骤，使用共享块序号。"""

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
    """后台结果的完成通知挂在末步，与插话共用块序号；对不上本轮的卡就不出通知，与实时投影一致。"""

    card = _find_tool(outcome.tool_call_id, tool_frames, frames_by_step)
    if card is None or not steps:
        return
    frames = frames_by_step[len(steps) - 1]
    frame_id = f"{turn_id}.{len(steps)}.f{next_frame_ordinal(frames)}"
    frames[frame_id] = background_notice(card, outcome, frame_id=frame_id)


def _claim(
    unclaimed: list[SteeredPrompt], content: tuple[PromptContent, ...]
) -> tuple[str, ...] | None:
    """按先后取第一条内容相同的插话行；enqueue_id 不进历史，只能这样把块对回消息。"""

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
    """从请求还原用户 part；媒体 tag 解析为附件，避免显示协议文本。后台工具的结果不算用户说的话。"""

    parts: list[PromptContent] = []
    for part in message.parts:
        if not isinstance(part, UserPromptPart) or parse_outcome(part) is not None:
            continue
        parts.extend(_part_content(part))
    return tuple(parts)


def _part_content(part: UserPromptPart) -> tuple[PromptContent, ...]:
    """一个用户 part 还原成的内容；实时侧一次递入正好是一个 part。"""

    items = [part.content] if isinstance(part.content, str) else list(part.content)
    return prompt_content(items)


def thinking_text(part: ThinkingPart) -> str:
    """思考块的展示文本：content 为空时拼接 provider_details 的 raw_content，两者都没有时为空串。

    Responses API 的原始思维链（如百炼的 reasoning_text）被 pydantic-ai 只存进
    provider_details['raw_content']，content 留空；回传供应方也读这份，所以展示层只读不改。
    """

    if part.content:
        return part.content
    return _joined_raw_content(part.provider_details)


def thinking_delta_text(delta: ThinkingPartDelta) -> str:
    """思考增量的展示文本，与 thinking_text 同一规则；没有新文本时为空串。

    原始思维链增量是 pydantic-ai 的更新函数，传 None 只返回本块；
    dict 形式的 provider_details 是整份合并而非增量，不算新文本。
    """

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
    """响应 part 转换为步骤块；正文与思考共用序号，工具使用 <stepId>.<toolCallId>。

    补记的加载调用不在这里建卡，随压缩提示挂到压缩后的那一步。
    """

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
    """一次调用刚发起时的工具卡。"""

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
    """压缩补记的一次技能加载，按普通加载卡显示，建卡时已带结果；实时与历史共用。"""

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
    """回填工具结果，收尾口径见 settle_tool_return；后台工具的回执照常结卡，并记进 awaiting_outcome。"""

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
    """返回最后一次模型响应中未处理的调用。

    调用方须通过 deferred_tool_results 处理这些前沿调用，才能提交新用户消息；已完成调用不可重复返回。
    """

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
"""无工具返回时的中断文案，用于结束已终止轮次中的开放工具卡。"""


def settle_tool_return(
    part: ToolReturnPart,
) -> tuple[Literal["done", "error"], object, object, str | None]:
    """一次工具返回收尾成工具卡的 (state, output, metadata, error)；两条投影都经这里，文案才一致。

    非成功结果（含要求重调的 retried）以返回原文作错误；框架补的 interrupted 返回等同没有返回，
    output 与 metadata 留空，错误写 ORPHAN_TOOL_ERROR。
    """

    if part.outcome == "interrupted":
        return "error", None, None, ORPHAN_TOOL_ERROR
    state = TOOL_STATE_BY_OUTCOME.get(part.outcome, "error")
    return state, part.content, part.metadata, None if state == "done" else str(part.content)


def _stamp_approval(
    tool_call_id: str,
    tool_frames: dict[str, str],
    frames_by_step: list[dict[str, TranscriptFrame]],
) -> None:
    """附加审批 id，供客户端关联审批操作。"""

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
    """将无结果调用标记为错误；等待审批的调用保持开放。

    有回执却没等到结果的后台调用也算无结果：历史里的运行都已不再存活，实时侧还活着的轮会盖掉这一份。
    """

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
    """统一转换引擎用量；input_tokens 已含缓存读写，计算普通输入时须扣除两者。"""

    if usage is None:
        return None
    return StepUsage(
        input_other=usage.input_tokens - usage.cache_read_tokens - usage.cache_write_tokens,
        output=usage.output_tokens,
        input_cache_read=usage.cache_read_tokens,
        input_cache_creation=usage.cache_write_tokens,
    )


def turn_usage(steps: Sequence[StepUsage]) -> TurnUsage | None:
    """汇总步骤用量；缓存写入计入 input，缓存读取单列。"""

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
