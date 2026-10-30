"""基于 UIEventStream 将运行事件投影为 transcript 操作，与 from_messages 共享编号和展示规则。

续跑通过 resume_from 继承整轮步骤、用量和工具卡。
后台工具的回执照常结卡并开一条 tool 任务；结果随递入消息到达时在到达处插一条完成通知、收尾任务，原卡不动。
DeferredToolRequests 仅结束当前 run，不发轮次终态；历史与审批请求交由运行侧持久化。
"""

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

from agent_runtime.harness.agents import SubAgentProfile
from agent_runtime.harness.background import BackgroundOutcome, is_receipt, parse_outcome
from agent_runtime.harness.context_compaction import (
    compaction_only,
    recorded_load_call,
    recorded_loads,
)
from agent_runtime.harness.transcript.from_messages import (
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
from agent_runtime.harness.transcript.prompt_media import plain_text, prompt_content
from agent_runtime.transcript.display import ToolDisplayRegistry
from agent_runtime.transcript.ops import (
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
"""单批操作共享一个序号，同一钩子须一次 yield 完整批次。"""


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _millis_since(started_at: str, ended_at: datetime) -> int:
    return int((ended_at - datetime.fromisoformat(started_at)).total_seconds() * 1000)


_Steer = tuple[tuple[PromptContent, ...], tuple[str, ...] | None]
"""一条插话：内容，以及它来自哪条消息（对不上时为 None）。"""


def _step_of(card: ToolFrame) -> str:
    """工具卡所在的步；卡的 id 是 <stepId>.<toolCallId>，据此回推，不依赖当前步号。"""

    return card.frame_id[: -len(card.tool_call_id) - 1]


@dataclass
class TranscriptEventStream(UIEventStream[Any, OpsBatch, Any, Any]):
    """将单次 run 投影为操作流，轮 id 与序号由调用方分配。"""

    _: KW_ONLY

    agent_id: str = MAIN_AGENT_ID
    turn_id: str = "t1"
    turn_ordinal: int = 1
    run_id: str | None = None
    """当前 run id，用于匹配响应与步骤用量。"""
    content: tuple[PromptContent, ...] = ()
    """轮次输入的原始 part 列表。"""
    prompt_id: str | None = None
    """发起本轮的消息 id；子代理的轮没有。"""
    steered: Mapping[str, str] = field(default_factory=dict)
    """enqueue_id → 消息 id。运行器递入插话时往同一个字典里写，插话块据此标 promptIds。"""
    max_context_tokens: int | None = None
    resume_from: TranscriptTurn | None = None
    """历史重建的续跑基线，新步骤从末步继续编号。"""
    repaired_calls: tuple[str, ...] = ()
    """框架补充 interrupted 返回但不发事件的调用。"""
    display: ToolDisplayRegistry = ToolDisplayRegistry.EMPTY
    """与历史投影共享的工具展示规则。"""

    _started_at: str = field(default_factory=_now, init=False)
    _step_started_at: str | None = field(default=None, init=False)
    """当前步开始的时间；历史侧取的是这一步之前那条请求的时间，两边都有值才对得上。"""
    _in_response: bool = field(default=False, init=False)
    _pending_step_break: bool = field(default=False, init=False)
    """插话让模型在同一次 run 里再答一次，中间没有工具调用，基类不会换步，下个 part 开始时自己换。"""
    _step_ordinal: int = field(default=0, init=False)
    _frame_ids: list[str] = field(default_factory=list[str], init=False)
    """当前步骤的块 id，用于分配后续正文与思考块序号。"""
    _open_frame_id: str | None = field(default=None, init=False)
    _open_text: str = field(default="", init=False)
    _step_usage: list[StepUsage] = field(default_factory=list[StepUsage], init=False)
    _tool_cards: dict[str, ToolFrame] = field(default_factory=dict[str, ToolFrame], init=False)
    """按 toolCallId 保存原工具卡，供结果到达时更新。"""
    _subagent_tasks: dict[str, TranscriptTask] = field(
        default_factory=dict[str, TranscriptTask], init=False
    )
    """按 toolCallId 保存本轮派出的子代理任务，供结果与轮次终态收尾。"""
    _background_tasks: dict[str, TranscriptTask] = field(
        default_factory=dict[str, TranscriptTask], init=False
    )
    """按 toolCallId 保存本次 run 收到回执的后台工具任务，供结果递入与运行收尾。"""
    _step_headers: list[StepHeader] = field(default_factory=list[StepHeader], init=False)
    """保留步骤头部，补充用量时不覆盖时间。"""
    _pending_steers: list[_Steer] = field(default_factory=list[_Steer], init=False)
    """尚无步骤承载的插话，插入下一步骤开头。"""
    _settled_calls: set[str] = field(default_factory=set[str], init=False)
    """已有结果的工具调用，供结束时识别未完成调用。"""
    _pending_summary: str | None = field(default=None, init=False)
    """待下一步骤承载的压缩摘要。"""
    _pending_loads: list[tuple[ToolCallPart, ToolReturnPart]] = field(
        default_factory=list[tuple[ToolCallPart, ToolReturnPart]], init=False
    )
    """待下一步骤承载的补记加载：调用与它的返回。"""

    deferred: DeferredToolRequests | None = field(default=None, init=False)
    """当前 run 的待审批请求，正常完成时为空。"""
    final_history: tuple[ModelMessage, ...] = field(default=(), init=False)
    """run 结束时的完整历史；开放工具调用的快照由运行侧保存。"""

    def __post_init__(self) -> None:
        """从历史基线初始化续跑状态；旧步骤不参与本次 run 的用量补充。"""

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
        # 保留尚未完成的原工具卡，续跑执行或 interrupted 返回均更新原卡。
        self._tool_cards = {
            frame.tool_call_id: frame
            for frame in last.frames
            if isinstance(frame, ToolFrame)
            and (
                frame.state == "running"
                or (frame.state == "error" and frame.error == ORPHAN_TOOL_ERROR)
            )
        }

    # --- 编码 ---------------------------------------------------------------

    def encode_event(self, event: OpsBatch) -> str:
        """编码操作批次；序号由实时存储分配。"""

        return json.dumps(
            [op.model_dump(by_alias=True, exclude_none=True) for op in event],
            ensure_ascii=False,
        )

    # --- 一轮的开合 ---------------------------------------------------------

    async def before_stream(self) -> AsyncIterator[OpsBatch]:
        """开始轮次，仅发送头部及框架修复的工具卡；续跑步骤已由基线写入。"""

        yield (
            TurnUpsertOp(turn=self._turn_header(state="running")),
            MetaMergeOp(meta=TranscriptMeta(activity="turn")),
            *self._repaired_card_ops(),
        )

    async def after_stream(self) -> AsyncIterator[OpsBatch]:
        if self._cancelled is not None or self._closed_with_error:
            # 取消或失败已发送终态，不能再覆盖为完成。
            return
        if self.deferred is not None:
            # 审批仅结束当前 run，轮次仍为 running。暂停等的调用保持开放，其余没结果的卡
            # （如暂停时被丢掉的后台调用）与历史重建一样收成中断，后台任务随之 killed。
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
        """将 repr(error) 写入轮次头部，与持久化事件保持一致。

        不生成 notice 块：首步可能尚未创建，且历史无法重建其所属步骤。
        """

        self._closed_with_error = True
        yield (
            *self._orphan_card_ops(),
            *self._orphan_task_ops("failed"),
            *self._orphan_background_ops("failed"),
            TurnUpsertOp(turn=self._turn_header(state="failed", error=repr(error))),
            MetaMergeOp(meta=TranscriptMeta(activity="idle")),
        )

    # --- 一步的开合 ---------------------------------------------------------

    def note_compaction(self, summary: str, records: Sequence[ModelMessage]) -> None:
        """暂存压缩提示与补记的加载卡，附加到下一步骤；没有后续步骤时都不显示。

        补记的交换由压缩写进历史、不经工具执行，没有工具事件，卡只能从这里建。
        """

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
        """从完整 ModelResponse 补充步骤用量，轮次合计由 after_stream 发送。

        异常或取消不触发此钩子，实时失败轮次的用量只能从后续历史读取。
        DeferredToolRequests 同时将历史与请求交给运行侧持久化。
        """

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
        """ReportContextUsage 在每次模型请求前的读数写入 agent meta；其余 capability 事件不投影。"""

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

    # --- 正文与思考 ---------------------------------------------------------

    async def handle_part_start(self, event: PartStartEvent) -> AsyncIterator[OpsBatch]:
        """插话后的重定向响应前面没有工具调用，基类不会换步；这里先收上一步、开下一步。"""

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

    # --- 工具 ---------------------------------------------------------------

    async def handle_function_tool_call(
        self, event: FunctionToolCallEvent
    ) -> AsyncIterator[OpsBatch]:
        """参数完整的工具调用开始时建卡，忽略参数增量。

        首个模型步骤前的调用属于旧轮次的前沿修复，不在当前轮新建卡。续跑已有历史基线，更新原卡。
        """

        if self._step_ordinal == 0:
            return

        # 审批续跑可能重新发送调用事件，须保留原卡的审批 id。
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
        # frame.upsert 整体替换工具卡，须保留参数和展示信息供结果更新。
        self._tool_cards[event.part.tool_call_id] = card
        yield (FrameUpsertOp(turn_id=self.turn_id, step_id=self._step_id, frame=card),)

    def note_subagent(
        self, tool_call_id: str, child_run_id: str, profile: SubAgentProfile
    ) -> OpsBatch:
        """把 delegate_task 派出的子运行记到父卡上，并开一条 subagent 任务。

        卡必定已在：FunctionToolCallEvent 先于工具执行到达；不在就是投影漏了事件，直接报错。
        一张卡只指向它最后一次派出的子运行：崩溃续跑会重放同一次调用，账本上也只记最后那个。
        profile 是子代理落库 metadata 的那份档案，历史侧从运行记录读回的是同一份。
        """

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
        """仅回填本轮已登记的工具卡，续跑使用原卡；忽略新消息触发的旧轮次前沿修复结果。

        运行出错或被停时基类替没返回的调用补的收尾也忽略：它不进历史，留给轮次收尾按孤儿卡处理。
        """

        part = event.part
        opened = self._tool_cards.get(part.tool_call_id)
        if opened is None:
            return
        if part.tool_call_id in self._pending_tool_calls:
            # 基类的 _pending_tool_calls（pydantic_ai 2.51 UIEventStream）在分发真实结果前已弹出该调用，
            # 只有异常收尾时补的返回到这里还挂着；升级框架时要复核这一点。
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
                    # interrupted 是「运行被停了」，与历史从子运行事件推出的 killed 对上。
                    "state": "completed" if state == "done" else "killed" if stopped else "failed",
                    "ended_at": _now(),
                    "result_summary": str(output) if state == "done" else None,
                    # 被停的任务没有错误文本，历史侧从子运行事件也推不出一句来。
                    "error": None if state == "done" or stopped else error,
                }
            )
            self._subagent_tasks[part.tool_call_id] = settled
            ops.append(TaskUpsertOp(task=settled))
        if is_receipt(part):
            # 后台工具的回执：卡照常结，调用还在后台跑，进度交给任务列表。
            started = background_task(opened, started_at=_now())
            self._background_tasks[part.tool_call_id] = started
            ops.append(TaskUpsertOp(task=started))
        yield tuple(ops)

    # --- 审批与插话 ---------------------------------------------------------

    async def handle_deferred_tool_requests(
        self, event: DeferredToolRequestsEvent
    ) -> AsyncIterator[OpsBatch]:
        """登记待审批交互，并将审批 id 同步保存至工具卡；轮次保持 running。"""

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
        """处理 capability 在同一 run 内完成审批的事件。

        本项目的跨 run 审批通过 deferred_tool_results 传入，不产生此事件。
        """

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
        """已递入的插话与后台工具结果按 part 顺序挂在当前末步，与历史投影一致。

        后台结果不成插话块：插一条完成通知、收尾任务，原卡不动。
        """

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
        # 结果与插话都让模型在同一次 run 里再答一次，中间没有工具调用，下个 part 开始时换步。
        if delivered and self._in_response:
            self._pending_step_break = True
        if ops:
            yield tuple(ops)

    # --- 内部 ---------------------------------------------------------------

    _closed_with_error: bool = field(default=False, init=False)

    @property
    def failed(self) -> bool:
        """读取运行失败状态；取消由官方 cancelled 标识区分。"""

        return self._closed_with_error

    @property
    def _step_id(self) -> str:
        return f"{self.turn_id}.{max(self._step_ordinal, 1)}"

    def _turn_header(self, *, state: str, error: str | None = None) -> TurnHeader:
        # 结束时间与耗时取同一个时刻，两者才对得上。
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
        """结束轮次或审批暂停时将无结果工具卡标记为错误，与历史投影一致。

        keep_open 是审批暂停所等的调用，这些卡保持 running。有回执却还没等到结果的后台调用也算
        无结果：运行到这里就不再存活，结果不会来了。output 与 metadata 清空，回执原文不留在卡上。
        """

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
        """轮次收尾时给仍在跑的子代理任务一个终态，否则界面永远停在 running。

        不写 stateReason：历史只能从子运行事件推出终态，写了两条路就对不上。
        """

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
        """运行收尾或审批暂停时，还在等结果的后台任务进入终态，口径见 interrupted_task_state。

        须排在 _orphan_card_ops 之后：那边按任务仍在 running 认出要收的卡。
        """

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
        """后台结果递入：当前末步插一条完成通知（与插话共用块序号），任务按结果收尾。

        对不上本轮的卡就什么都不出，与历史投影一致。
        """

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
        """处理框架补充 interrupted 返回但未发送事件的调用，按历史里那条返回收尾原卡。"""

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
        """压缩提示使用独立 id，不占 .f<n> 块序号。"""

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
        """先创建空块再追加已有内容，确保 append offset 相对已写入长度计算。"""

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
            # 协议 offset 使用 UTF-16 长度；Python len() 会在 emoji 等字符上产生偏差。
            offset=utf16_len(self._open_text),
            text=text,
        )
        self._open_text += text
        return [op]

    async def _flush(self, frame: type[Any], **extra: Any) -> AsyncIterator[OpsBatch]:
        """块结束时发送完整内容，修复易逝增量丢失造成的不完整文本。"""

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
    """按 run_id 筛选当前运行的模型响应，排除纯压缩边界与补记的加载调用。

    new_messages() 的起点可能被压缩边界前移，不能直接用于步骤用量归属。
    包含实际响应的合并消息仍计为一步；run_id 为空时仅排除压缩写入的响应。
    """

    recorded = recorded_loads(messages)
    return [
        message
        for message in messages
        if isinstance(message, ModelResponse)
        and not compaction_only(message, recorded)
        and (run_id is None or message.run_id == run_id)
    ]


def _prompt_content(part: UserPromptPart) -> tuple[PromptContent, ...]:
    """使用与历史相同的转换函数还原插话 part。"""

    items = [part.content] if isinstance(part.content, str) else list(part.content)
    return prompt_content(items)


def _approvals(results: DeferredToolResults) -> list[tuple[str, bool]]:
    """从 DeferredToolResults 读取工具调用的审批结果；ToolDenied 为拒绝，ToolApproved 为批准。"""

    return [
        (call_id, decision if isinstance(decision, bool) else not isinstance(decision, ToolDenied))
        for call_id, decision in results.approvals.items()
    ]


__all__ = ["OpsBatch", "TranscriptEventStream", "step_responses"]
