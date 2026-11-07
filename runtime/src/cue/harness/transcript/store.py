from __future__ import annotations

import uuid
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Final

from cue.transcript.ops import (
    AppendOp,
    EmittableOperation,
    FrameUpsertOp,
    Interaction,
    InteractionUpsertOp,
    ItemsRemoveOp,
    MetaMergeOp,
    Prompt,
    PromptUpsertOp,
    StepHeader,
    StepUpsertOp,
    TaskUpsertOp,
    TextFrame,
    ThinkingFrame,
    ToolFrame,
    TranscriptFrame,
    TranscriptMeta,
    TranscriptSnapshot,
    TranscriptStep,
    TranscriptTask,
    TranscriptTurn,
    TurnHeader,
    TurnUpsertOp,
    owned_task_ids,
    utf16_len,
)

JOURNAL_CAPACITY: Final = 2000

RESIDENT_CONVERSATIONS: Final = 256


@dataclass(frozen=True, slots=True)
class OpBatch:
    seq: int
    ops: tuple[EmittableOperation, ...]
    epoch: str


Listener = Callable[[OpBatch], None]


@dataclass(frozen=True, slots=True)
class SubscribeView:
    watermark: int
    epoch: str
    snapshot: TranscriptSnapshot
    live_turns: tuple[TranscriptTurn, ...]
    batches: tuple[OpBatch, ...]
    complete: bool


@dataclass(slots=True)
class _LiveStep:
    header: StepHeader
    frames: dict[str, TranscriptFrame] = field(default_factory=dict)


@dataclass(slots=True)
class _LiveTurn:
    header: TurnHeader
    steps: dict[str, _LiveStep] = field(default_factory=dict)
    snapshot_persisted: bool = False


@dataclass(slots=True)
class _AgentTranscript:
    epoch: str = field(default_factory=lambda: str(uuid.uuid4()))
    next_seq: int = 1
    journal: deque[OpBatch] = field(default_factory=lambda: deque(maxlen=JOURNAL_CAPACITY))
    turns: dict[str, _LiveTurn] = field(default_factory=dict)
    tasks: dict[str, TranscriptTask] = field(default_factory=dict)
    interactions: dict[str, Interaction] = field(default_factory=dict)
    prompts: dict[str, Prompt] = field(default_factory=dict)
    meta: TranscriptMeta = field(default_factory=TranscriptMeta)


@dataclass(slots=True)
class _Conversation:
    agents: dict[str, _AgentTranscript] = field(default_factory=dict)
    pins: int = 0


class TranscriptStore:
    def __init__(self, *, resident: int = RESIDENT_CONVERSATIONS) -> None:
        self._resident = resident
        self._conversations: dict[str, _Conversation] = {}
        self._listeners: dict[tuple[str, str], set[Listener]] = {}

    def append(
        self, conversation_id: str, agent_id: str, ops: tuple[EmittableOperation, ...]
    ) -> OpBatch:
        conversation = self._conversation(conversation_id)
        agent = conversation.agents.setdefault(agent_id, _AgentTranscript())
        batch = OpBatch(seq=agent.next_seq, ops=ops, epoch=agent.epoch)
        agent.next_seq += 1
        for op in ops:
            _apply(conversation, agent, op)
        agent.journal.append(batch)
        for listener in tuple(self._listeners.get((conversation_id, agent_id), ())):
            listener(batch)
        return batch

    def listen(self, conversation_id: str, agent_id: str, listener: Listener) -> None:
        self._listeners.setdefault((conversation_id, agent_id), set()).add(listener)

    def unlisten(self, conversation_id: str, agent_id: str, listener: Listener) -> None:
        key = (conversation_id, agent_id)
        listeners = self._listeners.get(key)
        if listeners is None:
            return
        listeners.discard(listener)
        if not listeners:
            del self._listeners[key]

    def mark_snapshot_persisted(self, conversation_id: str, agent_id: str, turn_id: str) -> None:
        turn = self._agent(conversation_id, agent_id).turns.get(turn_id)
        if turn is not None:
            turn.snapshot_persisted = True

    def drop_persisted_turns(self, conversation_id: str, agent_id: str) -> None:
        agent = self._agent(conversation_id, agent_id)
        agent.turns = {
            turn_id: turn for turn_id, turn in agent.turns.items() if not turn.snapshot_persisted
        }

    def subscribe_view(
        self,
        conversation_id: str,
        agent_id: str,
        *,
        since: int | None = None,
        epoch: str | None = None,
    ) -> SubscribeView:
        agent = self._agent(conversation_id, agent_id)
        watermark = agent.next_seq - 1
        batches, complete = self._since(agent, since, epoch)
        return SubscribeView(
            watermark=watermark,
            epoch=agent.epoch,
            snapshot=TranscriptSnapshot(
                tasks=tuple(agent.tasks.values()),
                interactions=tuple(agent.interactions.values()),
                prompts=tuple(agent.prompts.values()),
                meta=agent.meta,
            ),
            live_turns=tuple(_assemble(turn) for turn in agent.turns.values()),
            batches=batches,
            complete=complete,
        )

    def pending_interactions(self, conversation_id: str, agent_id: str) -> tuple[Interaction, ...]:
        agent = self._agent(conversation_id, agent_id)
        return tuple(item for item in agent.interactions.values() if item.state == "pending")

    def pin(self, conversation_id: str) -> None:
        self._conversation(conversation_id).pins += 1

    def unpin(self, conversation_id: str) -> None:
        conversation = self._conversations.get(conversation_id)
        if conversation is not None and conversation.pins > 0:
            conversation.pins -= 1

    def holds(self, conversation_id: str) -> bool:
        conversation = self._conversations.get(conversation_id)
        pinned = conversation is not None and conversation.pins > 0
        listened = any(key[0] == conversation_id for key in self._listeners)
        return pinned or listened

    def _conversation(self, conversation_id: str) -> _Conversation:
        conversation = self._conversations.pop(conversation_id, None) or _Conversation()
        self._conversations[conversation_id] = conversation
        self._evict()
        return conversation

    def _agent(self, conversation_id: str, agent_id: str) -> _AgentTranscript:
        return self._conversation(conversation_id).agents.setdefault(agent_id, _AgentTranscript())

    def _evict(self) -> None:
        if len(self._conversations) <= self._resident:
            return
        for conversation_id, conversation in list(self._conversations.items()):
            if len(self._conversations) <= self._resident:
                return
            if conversation.pins == 0:
                del self._conversations[conversation_id]

    @staticmethod
    def _since(
        agent: _AgentTranscript, since: int | None, epoch: str | None
    ) -> tuple[tuple[OpBatch, ...], bool]:
        if since is None:
            return (), True
        if epoch != agent.epoch:
            return (), False
        wanted = tuple(batch for batch in agent.journal if batch.seq > since)
        if not wanted:
            return (), since <= agent.next_seq - 1
        oldest = agent.journal[0].seq
        return wanted, oldest <= since + 1


def _apply(conversation: _Conversation, agent: _AgentTranscript, op: EmittableOperation) -> None:
    match op:
        case TurnUpsertOp():
            existing = agent.turns.get(op.turn.turn_id)
            if existing is None:
                agent.turns[op.turn.turn_id] = _LiveTurn(header=op.turn)
            else:
                existing.header = op.turn
        case StepUpsertOp():
            turn = agent.turns[op.turn_id]
            existing_step = turn.steps.get(op.step.step_id)
            if existing_step is None:
                turn.steps[op.step.step_id] = _LiveStep(header=op.step)
            else:
                existing_step.header = op.step
        case FrameUpsertOp():
            agent.turns[op.turn_id].steps[op.step_id].frames[op.frame.frame_id] = op.frame
        case AppendOp():
            step = agent.turns[op.target.turn_id].steps[op.target.step_id]
            frame = step.frames[op.target.frame_id]
            if not isinstance(frame, TextFrame | ThinkingFrame):
                raise ValueError(f"只有正文块与思考块能追加，{op.target.frame_id} 是 {frame.kind}")
            if utf16_len(frame.text) != op.offset:
                raise ValueError(
                    f"追加位置对不上：块 {op.target.frame_id} 现有 "
                    f"{utf16_len(frame.text)} 个 UTF-16 单位，这一条要从 {op.offset} 接"
                )
            step.frames[op.target.frame_id] = frame.model_copy(
                update={"text": frame.text + op.text}
            )
        case TaskUpsertOp():
            agent.tasks[op.task.task_id] = op.task
        case InteractionUpsertOp():
            agent.interactions[op.interaction.interaction_id] = op.interaction
        case PromptUpsertOp():
            agent.prompts[op.prompt.prompt_id] = op.prompt
        case MetaMergeOp():
            update = op.meta.model_dump(exclude_none=True, by_alias=False)
            if op.meta.agent is not None and agent.meta.agent is not None:
                update["agent"] = agent.meta.agent.model_copy(
                    update=op.meta.agent.model_dump(exclude_none=True, by_alias=False)
                )
            elif op.meta.agent is not None:
                update["agent"] = op.meta.agent
            agent.meta = agent.meta.model_copy(update=update)
        case ItemsRemoveOp():
            _remove_items(conversation, agent, op.ids)
        case _:
            raise ValueError(f"实时状态不接受这种操作：{op.op}")


def _remove_items(
    conversation: _Conversation, agent: _AgentTranscript, ids: tuple[str, ...]
) -> None:
    cards = [
        frame
        for turn_id in ids
        if (turn := agent.turns.get(turn_id)) is not None
        for step in turn.steps.values()
        for frame in step.frames.values()
        if isinstance(frame, ToolFrame)
    ]
    orphaned = {frame.tool_call_id for frame in cards}
    children = {ref.agent_id for frame in cards for ref in frame.agent_refs or ()}
    for turn_id in ids:
        agent.turns.pop(turn_id, None)
    for task_id in owned_task_ids(cards):
        agent.tasks.pop(task_id, None)
    for child_id in children:
        conversation.agents.pop(child_id, None)
    agent.interactions = {
        key: item
        for key, item in agent.interactions.items()
        if item.tool_call_id is None or item.tool_call_id not in orphaned
    }


def _assemble(turn: _LiveTurn) -> TranscriptTurn:
    return TranscriptTurn(
        **turn.header.model_dump(by_alias=False),
        steps=tuple(
            TranscriptStep(
                **step.header.model_dump(by_alias=False), frames=tuple(step.frames.values())
            )
            for step in turn.steps.values()
        ),
    )


__all__ = [
    "JOURNAL_CAPACITY",
    "RESIDENT_CONVERSATIONS",
    "Listener",
    "OpBatch",
    "SubscribeView",
    "TranscriptStore",
]
