"""从快照、运行结束事件与 run→prompt 映射重建历史，三者以 run_id 关联。

读取完整消息快照后由调用方分页。包含中断快照，与运行入口保持相同口径，避免丢失失败轮次或复用轮号。
"""

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

from iclip.harness.agents import SubAgentProfile
from iclip.harness.job_status import JobStatus
from iclip.harness.transcript.from_messages import (
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
from iclip.platform.transcript.display import ToolDisplayRegistry
from iclip.platform.transcript.ops import (
    AgentDescriptor,
    Interaction,
    TranscriptTask,
    TranscriptTurn,
    agents_from_tasks,
)


class ConversationSnapshots(StepStore, Protocol):
    """历史读取与截断所需的存储协议；截断保存为新快照，保留旧记录。

    在官方 StepStore 之上多一个按对话取快照的入口，和三个批量读：重建一段历史要看每个运行的事件、
    下属运行与派发账本，逐个运行去查会让查询条数随运行数增长，批量读让它固定。
    """

    async def latest_conversation_snapshot(
        self, *, conversation_id: str, include_interrupted: bool = False
    ) -> ContinuableSnapshot | None: ...

    async def list_events_for_runs(self, run_ids: Sequence[str]) -> Mapping[str, list[StepEvent]]:
        """多个运行的事件，各自按 seq 升序；问到的运行都在结果里，没有事件的是空列表。"""
        ...

    async def list_child_runs(self, parent_run_ids: Sequence[str]) -> Mapping[str, list[RunRecord]]:
        """按父运行分组的下属运行，组内按开跑时刻；问到的父运行都在结果里，没有下属的是空列表。"""
        ...

    async def get_tool_effects(
        self, keys: Sequence[tuple[str, str]]
    ) -> Mapping[tuple[str, str], ToolEffectRecord]:
        """按 ``(run_id, tool_call_id)`` 取工具账本；没有记录的键不在结果里。"""
        ...


class PromptRunsSource(Protocol):
    """查询 run 所属消息及其当前状态。"""

    async def prompt_of_runs(self, conversation_id: str) -> dict[str, str]: ...

    async def prompt_status_of_runs(self, conversation_id: str) -> dict[str, JobStatus]: ...

    async def steered_prompts(self, conversation_id: str) -> tuple[SteeredPrompt, ...]:
        """本对话插过话的消息，按插话先后。"""
        ...


@dataclass(frozen=True, slots=True)
class TranscriptHistoryView:
    turns: tuple[TranscriptTurn, ...]
    context_tokens: int | None
    interactions: tuple[Interaction, ...] = ()
    """持久化审批视图，供进程重启后恢复待处理交互。"""
    tasks: tuple[TranscriptTask, ...] = ()
    """本对话派出过的子代理任务。"""
    agents: tuple[AgentDescriptor, ...] = ()


@dataclass(frozen=True, slots=True)
class TranscriptHistory:
    """根据对话 id 重建历史轮次。"""

    store: ConversationSnapshots
    prompt_runs: PromptRunsSource
    display: ToolDisplayRegistry = ToolDisplayRegistry.EMPTY
    """与实时运行共享的工具卡展示规则。"""
    delegate_tool: str | None = None
    """派发工具名；留空则不查子代理账本。"""

    async def read(self, conversation_id: str) -> TranscriptHistoryView:
        """读取可恢复的时间线与 Pydantic AI 上下文读数。"""

        snapshot = await self.store.latest_conversation_snapshot(
            conversation_id=conversation_id, include_interrupted=True
        )
        if snapshot is None:
            return TranscriptHistoryView(turns=(), context_tokens=None)
        run_ids = run_ids_from_messages(snapshot.messages)
        events_of = await self.store.list_events_for_runs(run_ids)
        states: dict[str, TurnState] = {}
        errors: dict[str, str | None] = {}
        for run_id in run_ids:
            events = events_of[run_id]
            states[run_id] = run_state_from_events(events)
            # 取消不是错误：实时侧的 cancelled 轮不带 error，这里也不把 CancelledError 当错误文本。
            errors[run_id] = (
                None if states[run_id] == "cancelled" else run_error_from_events(events)
            )
        of_run = await self.prompt_runs.prompt_of_runs(conversation_id)
        status_of_run = await self.prompt_runs.prompt_status_of_runs(conversation_id)
        steered = await self.prompt_runs.steered_prompts(conversation_id)
        subagent_of_call, tasks = await self._delegations(snapshot.messages, run_ids, events_of)
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
        """本对话派出过的子代理任务，与 ``read`` 给的 ``tasks`` 相同；只推导任务，不重建轮次。

        子代理页取名册用：只要快照、派发账本与下属运行，不必为它把主流整段重建一遍。
        """

        snapshot = await self.store.latest_conversation_snapshot(
            conversation_id=conversation_id, include_interrupted=True
        )
        if snapshot is None:
            return ()
        run_ids = run_ids_from_messages(snapshot.messages)
        _, tasks = await self._delegations(snapshot.messages, run_ids, {})
        return tasks

    async def _delegations(
        self,
        messages: Sequence[ModelMessage],
        run_ids: Sequence[str],
        parent_events: Mapping[str, Sequence[StepEvent]],
    ) -> tuple[dict[str, str], tuple[TranscriptTask, ...]]:
        """派发调用对上的子运行 id 与本对话的子代理任务，``read`` 与 ``read_tasks`` 共用。

        ``parent_events`` 是调用方已查到的父运行事件；没给的父运行，只有派过下属的才要看终态，
        在这里与下属运行的事件合成一次查询补上。
        """

        subagent_of_call = await self._subagent_of_call(messages)
        tasks = tasks_from_messages(
            messages,
            subagent_of_call=subagent_of_call,
            child_runs=await self._child_runs(run_ids, parent_events),
        )
        return subagent_of_call, tasks

    async def read_child(self, child_run_id: str) -> TranscriptHistoryView:
        """按子运行 id 重建子代理那条流；一次派发就是它的 t1。

        子运行没有自己的终态而父运行被停时随父算 cancelled，与任务表同口径。
        没落过快照的子运行读出来是空的，与主 agent 首个响应期间被停的边界相同。
        """

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
        """从工具账本读出每次派发调用对上的子运行 id；父工具卡与任务都按它认领。"""

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
        self, run_ids: Sequence[str], parent_events: Mapping[str, Sequence[StepEvent]]
    ) -> tuple[ChildRun, ...]:
        """按运行血缘取本对话每个 run 的下属运行；终态与结束时间来自它们自己的事件。

        父运行被停止时子运行收到的是 asyncio 取消，官方不会给它写终态事件；
        这种没有自己终态的子运行随父运行算 cancelled，与实时侧的 killed 对上。
        下属运行一次查完，它们的事件与 ``parent_events`` 里缺的父运行事件再一次查完。
        """

        if self.delegate_tool is None:
            return ()
        children_of = await self.store.list_child_runs(run_ids)
        missing = [
            run_id for run_id in run_ids if children_of[run_id] and run_id not in parent_events
        ]
        child_ids = [record.run_id for run_id in run_ids for record in children_of[run_id]]
        fetched = await self.store.list_events_for_runs([*missing, *child_ids])
        children: list[ChildRun] = []
        for run_id in run_ids:
            if not children_of[run_id]:
                continue
            parent_state = run_state_from_events(
                parent_events[run_id] if run_id in parent_events else fetched[run_id]
            )
            for record in children_of[run_id]:
                events = fetched[record.run_id]
                state = run_state_from_events(events)
                if not _ended(events) and parent_state == "cancelled":
                    state = "cancelled"
                # 子运行的 metadata 就是装配时写入的档案；按 get 读，缺键得 None。
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
        """这段对话一共几轮。分叉在动手拷贝之前用它挡掉越界的分叉点。"""

        snapshot = await self.store.latest_conversation_snapshot(
            conversation_id=conversation_id, include_interrupted=True
        )
        messages = [] if snapshot is None else snapshot.messages
        of_run = await self.prompt_runs.prompt_of_runs(conversation_id)
        return len(turn_run_ids(messages, of_run))

    async def plan_fork(
        self, conversation_id: str, *, ordinal: int, target_conversation_id: str
    ) -> ForkSeed | None:
        """规划一次分叉，不写库；轮号越界返回 None。

        消息里的 run_id 原样保留：副本不复制运行记录，靠这些 id 回源查终态与子代理。
        """

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
        """从同一快照验证并规划末轮截断，不写库；非末轮返回 None。

        调用方可先检查相关 run 数据，再提交截断，避免校验失败后已丢失末轮。
        """

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


def _ended(events: Sequence[StepEvent]) -> bool:
    """有没有官方写的终态事件；被父运行连带取消的子运行没有。"""

    return any(event.kind in {"run_completed", "run_failed"} for event in events)


@dataclass(frozen=True, slots=True)
class ForkSeed:
    """尚未落库的分叉起点：截到某一轮的消息，等着写成副本的第一张快照。"""

    store: ConversationSnapshots
    conversation_id: str
    """副本的对话 id，不是源的。"""
    kept: list[ModelMessage]

    async def commit(self) -> None:
        """把起点存成副本的快照；这张快照的 run_id 不参与消息分轮，与截断保存同一口径。"""

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
    """尚未落库的截断计划，run_ids 为末轮包含的运行。"""

    store: ConversationSnapshots
    conversation_id: str
    kept: list[ModelMessage]
    run_ids: tuple[str, ...]

    async def commit(self) -> None:
        """将截断结果保存为新快照，保留旧快照和事件；新快照 run_id 不参与消息分轮。"""

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
