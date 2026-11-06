from __future__ import annotations

import re
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime

import structlog

from agent_runtime.errors import AgentUnavailable, Conflict, NotFound, ValidationFailed
from agent_runtime.harness.jobs import JobQueue, JobRow
from agent_runtime.harness.transcript.history import TranscriptHistory
from agent_runtime.harness.transcript.runner import ConversationRunner
from agent_runtime.harness.transcript.store import Listener, TranscriptStore
from agent_runtime.harness.transcript.subscription import SubscribeFrames, subscribe_frames
from agent_runtime.transcript.ops import (
    MAIN_AGENT_ID,
    ImageContent,
    Interaction,
    ItemsRemoveOp,
    Prompt,
    PromptContent,
    TranscriptTask,
    TranscriptTurn,
    VideoContent,
    agent_context_status,
    agents_from_tasks,
)
from agent_runtime.transcript.wire import (
    OpsBatchOut,
    OpsCatchup,
    PromptQueueOut,
    RunStatusOut,
    TranscriptPage,
)
from agent_runtime.urls import is_http_url, is_oss_processable

_logger = structlog.stdlib.get_logger(__name__)

DEFAULT_PAGE_SIZE = 20
MAX_PAGE_SIZE = 100

_BUSY = "这段对话还在忙，等它收完尾再重新生成"


@dataclass(frozen=True, slots=True)
class TranscriptService:
    store: TranscriptStore
    history: TranscriptHistory
    queue: JobQueue
    runner: ConversationRunner

    async def submit(
        self,
        *,
        prompt_id: str,
        conversation_id: str,
        agent_id: str,
        owner_user_id: uuid.UUID,
        user_name: str,
        content: tuple[PromptContent, ...],
    ) -> Prompt:
        _check_content(content)
        await self.runner.agents.for_conversation(conversation_id, agent_id)
        submission = await self.queue.submit(
            prompt_id=prompt_id,
            conversation_id=conversation_id,
            agent_id=agent_id,
            owner_user_id=owner_user_id,
            user_name=user_name,
            content=content,
            now=datetime.now(UTC),
            locked_by=self.runner.locked_by,
        )
        if submission.accepted:
            await self.runner.submit(submission.row)
        return submission.row.as_entity()

    async def abort(self, conversation_id: str, prompt_id: str) -> None:
        await self.runner.abort(conversation_id, prompt_id)

    async def regenerate(
        self,
        *,
        conversation_id: str,
        turn_id: str,
        prompt_id: str | None = None,
        content: tuple[PromptContent, ...] | None = None,
    ) -> Prompt:
        match = re.fullmatch(r"t([1-9]\d*)", turn_id)
        if match is None:
            raise ValidationFailed(f"不是合法的轮 id：{turn_id}")
        ordinal = int(match.group(1))
        if prompt_id is not None:
            claimed = await self.queue.get(prompt_id)
            if claimed is not None:
                if claimed.conversation_id != conversation_id:
                    raise Conflict("这个消息 id 已经用过了，换一个")
                return claimed.as_entity()
        view = await self.queue.view(conversation_id)
        if view.active is not None or view.queued:
            raise Conflict(_BUSY)
        rewind = await self.history.plan_rewind(conversation_id, ordinal=ordinal)
        if rewind is None:
            raise Conflict("只能重新生成最后一轮")
        row = await self.queue.get_by_run(rewind.run_ids[0], conversation_id=conversation_id)
        if row is None:
            raise NotFound("分叉带过来的历史不能重新生成或编辑，只能接着往下聊。")
        replay = row.content if content is None else content
        _check_content(replay)
        await self.runner.agents.for_conversation(conversation_id, row.agent_id)
        submission = await self.queue.submit(
            prompt_id=f"prm_regen_{uuid.uuid4().hex[:16]}" if prompt_id is None else prompt_id,
            conversation_id=conversation_id,
            agent_id=row.agent_id,
            owner_user_id=row.owner_user_id,
            user_name=row.user_name,
            content=replay,
            now=datetime.now(UTC),
            locked_by=self.runner.locked_by,
        )
        regenerated = submission.row
        if not submission.accepted:
            return regenerated.as_entity()
        if regenerated.status != "running":
            withdrawn = await self.queue.abort(
                regenerated.prompt_id, conversation_id=conversation_id, now=datetime.now(UTC)
            )
            if withdrawn.status == "running":
                _logger.warning(
                    "重新生成的消息排队后被队首启动，按普通消息跑",
                    prompt_id=regenerated.prompt_id,
                    conversation_id=conversation_id,
                )
            raise Conflict(_BUSY)
        try:
            current = await self.history.plan_rewind(conversation_id, ordinal=ordinal)
            if current is None or current.run_ids != rewind.run_ids:
                raise Conflict("末轮刚刚变了，刷新之后再重新生成")
            await current.commit()
        except BaseException:
            await self._withdraw(regenerated)
            raise
        self.store.append(conversation_id, MAIN_AGENT_ID, (ItemsRemoveOp(ids=(turn_id,)),))
        await self.runner.submit(regenerated)
        return regenerated.as_entity()

    async def _withdraw(self, row: JobRow) -> None:
        await self.queue.finish(
            row.prompt_id,
            status="aborted",
            now=datetime.now(UTC),
            locked_by=self.runner.locked_by,
            attempt=row.attempt,
        )

    async def abort_conversation(self, conversation_id: str) -> None:
        await self.runner.abort_conversation(conversation_id)

    async def steer(self, conversation_id: str, prompt_ids: tuple[str, ...]) -> None:
        await self.runner.steer(conversation_id, prompt_ids)

    async def approve(self, conversation_id: str, interaction_id: str, *, approved: bool) -> None:
        await self.runner.approve(conversation_id, interaction_id, approved=approved)

    async def verify_agent(self, conversation_id: str, agent_id: str) -> None:
        if agent_id == MAIN_AGENT_ID:
            return
        record = await self.history.store.get_run(run_id=agent_id)
        parent = (
            None
            if record is None or record.parent_run_id is None
            else await self.history.store.get_run(run_id=record.parent_run_id)
        )
        if parent is None or parent.conversation_id != conversation_id:
            raise NotFound("这段对话里没有这个 agent")

    async def queue_view(self, conversation_id: str) -> PromptQueueOut:
        view = await self.queue.view(conversation_id)
        return PromptQueueOut(
            active=None if view.active is None else view.active.as_entity(),
            queued=tuple(row.as_entity() for row in view.queued),
        )

    async def run_status(self, conversation_id: str) -> RunStatusOut:
        view = await self.queue.view(conversation_id)
        if view.active is not None:
            return RunStatusOut(
                status="awaiting" if view.active.status == "awaiting" else "running"
            )
        if view.queued:
            return RunStatusOut(status="running")
        activity = (await self.queue.activities([conversation_id]))[conversation_id]
        return RunStatusOut(status=activity.last_turn_reason or "idle")

    async def _context_window(self, conversation_id: str, agent_id: str) -> int | None:
        try:
            resolved = await self.runner.agents.for_conversation(conversation_id, agent_id)
        except AgentUnavailable:
            return None
        return resolved.context_window

    async def page(
        self,
        conversation_id: str,
        *,
        agent_id: str = MAIN_AGENT_ID,
        runtime_agent_id: str,
        before_turn: str | None = None,
        after_turn: str | None = None,
        page_size: int = DEFAULT_PAGE_SIZE,
    ) -> TranscriptPage:
        if before_turn is not None and after_turn is not None:
            raise ValidationFailed("before_turn 与 after_turn 只能给一个")
        size = max(1, min(page_size, MAX_PAGE_SIZE))
        if agent_id != MAIN_AGENT_ID:
            return await self._child_page(
                conversation_id, agent_id, before_turn=before_turn, after_turn=after_turn, size=size
            )
        view = self.store.subscribe_view(conversation_id, agent_id)
        history = await self.history.read(conversation_id)
        turns = _timeline(history.turns, view.live_turns)
        items, has_more = _slice(turns, before_turn=before_turn, after_turn=after_turn, size=size)
        interactions = _interactions(history.interactions, view.snapshot.interactions)
        tasks = _tasks(history.tasks, view.snapshot.tasks)
        meta = view.snapshot.meta
        max_context_tokens = await self._context_window(conversation_id, runtime_agent_id)
        if (
            meta.agent is None
            and history.context_tokens is not None
            and max_context_tokens is not None
        ):
            meta = meta.model_copy(
                update={"agent": agent_context_status(history.context_tokens, max_context_tokens)}
            )
        if (await self.queue.view(conversation_id)).active is not None:
            meta = meta.model_copy(update={"activity": "turn"})
        elif meta.activity is None:
            meta = meta.model_copy(update={"activity": "idle"})
        return TranscriptPage(
            agent_id=agent_id,
            items=items,
            has_more=has_more,
            tasks=tasks,
            interactions=interactions,
            prompts=view.snapshot.prompts,
            meta=meta,
            agents=agents_from_tasks(tasks),
            pending_interactions=tuple(
                item.interaction_id for item in interactions if item.state == "pending"
            ),
            seq=view.watermark,
            stream_epoch=view.epoch,
        )

    async def _child_page(
        self,
        conversation_id: str,
        agent_id: str,
        *,
        before_turn: str | None,
        after_turn: str | None,
        size: int,
    ) -> TranscriptPage:
        view = self.store.subscribe_view(conversation_id, agent_id)
        history = await self.history.read_child(agent_id)
        items, has_more = _slice(
            _timeline(history.turns, view.live_turns),
            before_turn=before_turn,
            after_turn=after_turn,
            size=size,
        )
        meta = view.snapshot.meta
        if meta.activity is None:
            meta = meta.model_copy(update={"activity": "idle"})
        roster = _tasks(
            await self.history.read_tasks(conversation_id),
            self.store.subscribe_view(conversation_id, MAIN_AGENT_ID).snapshot.tasks,
        )
        return TranscriptPage(
            agent_id=agent_id,
            items=items,
            has_more=has_more,
            meta=meta,
            agents=agents_from_tasks(roster),
            seq=view.watermark,
            stream_epoch=view.epoch,
        )

    def catchup(
        self,
        conversation_id: str,
        *,
        agent_id: str = MAIN_AGENT_ID,
        since: int,
        epoch: str | None = None,
    ) -> OpsCatchup:
        current = self.store.subscribe_view(conversation_id, agent_id)
        view = self.store.subscribe_view(
            conversation_id,
            agent_id,
            since=since,
            epoch=current.epoch if epoch is None else epoch,
        )
        return OpsCatchup(
            agent_id=agent_id,
            batches=tuple(OpsBatchOut(seq=batch.seq, ops=batch.ops) for batch in view.batches),
            latest_seq=view.watermark,
            complete=view.complete,
            stream_epoch=view.epoch,
        )

    def subscribe(
        self,
        conversation_id: str,
        *,
        agent_id: str = MAIN_AGENT_ID,
        since: int | None,
        epoch: str | None = None,
    ) -> SubscribeFrames:
        view = self.store.subscribe_view(conversation_id, agent_id, since=since, epoch=epoch)
        return SubscribeFrames(
            stream_epoch=view.epoch,
            frames=subscribe_frames(view, agent_id=agent_id, since=since),
        )

    def listen(self, conversation_id: str, listener: Listener, *, agent_id: str) -> None:
        self.store.listen(conversation_id, agent_id, listener)

    def unlisten(self, conversation_id: str, listener: Listener, *, agent_id: str) -> None:
        self.store.unlisten(conversation_id, agent_id, listener)

    def pin(self, conversation_id: str) -> None:
        self.store.pin(conversation_id)

    def unpin(self, conversation_id: str) -> None:
        self.store.unpin(conversation_id)


def _check_content(content: Sequence[PromptContent]) -> None:
    if not content:
        raise ValidationFailed("消息是空的")
    for part in content:
        if not isinstance(part, ImageContent | VideoContent):
            continue
        url = part.source.url
        if url is None or not is_http_url(url):
            raise ValidationFailed("附件地址必须是 http(s) 地址")
        if isinstance(part, ImageContent) and not is_oss_processable(url):
            raise ValidationFailed(
                f"图片附件的地址要能挂 OSS 图片处理参数（OSS 域名、不带 query），这个地址不行：{url}"
            )


def _timeline(
    derived: tuple[TranscriptTurn, ...], live: tuple[TranscriptTurn, ...]
) -> tuple[TranscriptTurn, ...]:
    merged = {turn.ordinal: turn for turn in derived}
    merged.update({turn.ordinal: turn for turn in live})
    return tuple(merged[ordinal] for ordinal in sorted(merged))


def _tasks(
    derived: tuple[TranscriptTask, ...], live: tuple[TranscriptTask, ...]
) -> tuple[TranscriptTask, ...]:
    merged = {item.task_id: item for item in derived}
    merged.update({item.task_id: item for item in live})
    return tuple(sorted(merged.values(), key=lambda item: item.task_id))


def _interactions(
    derived: tuple[Interaction, ...], live: tuple[Interaction, ...]
) -> tuple[Interaction, ...]:
    merged = {item.interaction_id: item for item in derived}
    merged.update({item.interaction_id: item for item in live})
    return tuple(merged.values())


def _slice(
    turns: tuple[TranscriptTurn, ...], *, before_turn: str | None, after_turn: str | None, size: int
) -> tuple[tuple[TranscriptTurn, ...], bool]:
    if before_turn is not None:
        end = _index(turns, before_turn)
        start = max(0, end - size)
        return turns[start:end], start > 0
    if after_turn is not None:
        start = _index(turns, after_turn) + 1
        return turns[start : start + size], start > 0
    start = max(0, len(turns) - size)
    return turns[start:], start > 0


def _index(turns: tuple[TranscriptTurn, ...], turn_id: str) -> int:
    for position, turn in enumerate(turns):
        if turn.turn_id == turn_id:
            return position
    raise ValidationFailed(f"这段对话里没有这一轮：{turn_id}")


__all__ = ["DEFAULT_PAGE_SIZE", "MAX_PAGE_SIZE", "TranscriptService"]
