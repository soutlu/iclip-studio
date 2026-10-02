"""验证重新生成的末轮重放、幂等和 HTTP 错误契约，以及半途失败时原历史不动；寻址使用 t{N} 轮 id。"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI
from pydantic_ai.messages import ModelMessage, ModelRequest, UserPromptPart
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai_harness.step_persistence import ContinuableSnapshot
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.common.errors import Conflict, ValidationFailed
from iclip.config import ResolvedAgent
from iclip.harness.jobs import JobQueue, JobQueueView, Submission
from iclip.harness.step_store_pg import PgStepStore
from iclip.harness.transcript.activity import ActivityState
from iclip.harness.transcript.history import TranscriptHistory, TurnRewind
from iclip.harness.transcript.runner import ConversationRunner
from iclip.harness.transcript.service import TranscriptService
from iclip.harness.transcript.store import TranscriptStore
from iclip.platform.transcript.ops import (
    MAIN_AGENT_ID,
    AttachmentSource,
    ImageContent,
    ItemsRemoveOp,
    PromptContent,
    TextContent,
    TextFrame,
)
from tests.helpers.agents import declared_agent
from tests.helpers.app import TEST_MODEL_NAME, make_client, new_conversation, settled
from tests.helpers.auth import login_as_editor, register_and_login, set_roles_in_db
from tests.helpers.pg import connected
from tests.helpers.runtime import (
    MAX_CONTEXT_TOKENS,
    OWNER,
    build_runner,
    drained,
    new_conversation_id,
    prompt_text,
    records_nothing,
    says,
    submit_text,
)

AGENT_ID = "storyboard"


@pytest.fixture
def agent_declarations(tmp_path: Path) -> tuple[ResolvedAgent, ...]:
    return (declared_agent(tmp_path, AGENT_ID),)


def _last_user_text(messages: list[ModelMessage]) -> str:
    for message in reversed(messages):
        if isinstance(message, ModelRequest):
            for part in message.parts:
                if not isinstance(part, UserPromptPart):
                    continue
                items = [part.content] if isinstance(part.content, str) else list(part.content)
                texts = [item for item in items if isinstance(item, str)]
                if texts:
                    return "\n".join(texts)
    return ""


@pytest.fixture
def models() -> dict[str, FunctionModel]:
    """延迟响应以覆盖对话忙碌窗口；提供 stream_function 以适配流式运行。"""

    async def reply(messages: list[ModelMessage], _info: AgentInfo) -> AsyncIterator[str]:
        await asyncio.sleep(0.5)
        yield f"答：{_last_user_text(messages)}"

    return {TEST_MODEL_NAME: FunctionModel(stream_function=reply)}


async def _send(
    client: httpx.AsyncClient, conversation_id: str, prompt_id: str, text_: str
) -> None:
    sent = await client.post(
        f"/conversations/{conversation_id}/prompts",
        json={"prompt_id": prompt_id, "content": [{"type": "text", "text": text_}]},
    )
    assert sent.status_code == 200, sent.text


async def _run_count(pg_url: str, conversation_id: str) -> int:
    """统计持久化 run 数；重新生成保留旧 run 并新增记录。"""

    async with connected(pg_url) as conn:
        return (
            await conn.execute(
                text("SELECT count(*) FROM agent_runtime.runs WHERE conversation_id = :cid"),
                {"cid": conversation_id},
            )
        ).scalar_one()


async def test_regenerate_replays_the_last_turn(app: FastAPI, pg_url: str) -> None:

    async with make_client(app) as client:
        await login_as_editor(client, pg_url)
        conversation_id = await new_conversation(client, AGENT_ID)
        await _send(client, conversation_id, "prm_r1", "第一问")
        await settled(client, conversation_id)
        await _send(client, conversation_id, "prm_r2", "第二问")
        await settled(client, conversation_id)

        replayed = await client.post(f"/conversations/{conversation_id}/turns/t2:regenerate")
        assert replayed.status_code == 200, replayed.text
        assert replayed.json()["promptId"] != "prm_r2"
        assert replayed.json()["status"] == "running"
        assert replayed.json()["content"] == [{"type": "text", "text": "第二问"}]
        await settled(client, conversation_id)
        page = (await client.get(f"/conversations/{conversation_id}/transcript")).json()

    assert [turn["turnId"] for turn in page["items"]] == ["t1", "t2"]
    assert [turn["content"] for turn in page["items"]] == [
        [{"type": "text", "text": "第一问"}],
        [{"type": "text", "text": "第二问"}],
    ]
    assert page["items"][1]["steps"][0]["frames"][0]["text"] == "答：第二问"

    assert await _run_count(pg_url, conversation_id) == 3


async def test_regenerate_with_new_content_replays_the_edited_message(
    app: FastAPI, pg_url: str
) -> None:

    async with make_client(app) as client:
        await login_as_editor(client, pg_url)
        conversation_id = await new_conversation(client, AGENT_ID)
        await _send(client, conversation_id, "prm_e1", "第一问")
        await settled(client, conversation_id)
        await _send(client, conversation_id, "prm_e2", "第二问")
        await settled(client, conversation_id)

        edited = await client.post(
            f"/conversations/{conversation_id}/turns/t2:regenerate",
            json={"content": [{"type": "text", "text": "改口再问"}]},
        )
        assert edited.status_code == 200, edited.text
        assert edited.json()["content"] == [{"type": "text", "text": "改口再问"}]
        await settled(client, conversation_id)
        page = (await client.get(f"/conversations/{conversation_id}/transcript")).json()

    assert [turn["turnId"] for turn in page["items"]] == ["t1", "t2"]
    assert [turn["content"] for turn in page["items"]] == [
        [{"type": "text", "text": "第一问"}],
        [{"type": "text", "text": "改口再问"}],
    ]
    assert page["items"][1]["steps"][0]["frames"][0]["text"] == "答：改口再问"
    assert await _run_count(pg_url, conversation_id) == 3


async def test_regenerating_twice_with_the_same_prompt_id_returns_the_first(
    app: FastAPI, pg_url: str
) -> None:
    """幂等请求认领须早于忙碌检查，避免重试被拒或重复截断末轮。"""

    async with make_client(app) as client:
        await login_as_editor(client, pg_url)
        conversation_id = await new_conversation(client, AGENT_ID)
        await _send(client, conversation_id, "prm_t1", "第一问")
        await settled(client, conversation_id)
        await _send(client, conversation_id, "prm_t2", "第二问")
        await settled(client, conversation_id)

        first = await client.post(
            f"/conversations/{conversation_id}/turns/t2:regenerate",
            json={"prompt_id": "prm_retry"},
        )
        again = await client.post(
            f"/conversations/{conversation_id}/turns/t2:regenerate",
            json={"prompt_id": "prm_retry"},
        )
        assert first.status_code == 200, first.text
        assert again.status_code == 200, again.text
        assert first.json()["promptId"] == "prm_retry"
        assert again.json()["promptId"] == "prm_retry"
        await settled(client, conversation_id)
        page = (await client.get(f"/conversations/{conversation_id}/transcript")).json()

    assert [turn["turnId"] for turn in page["items"]] == ["t1", "t2"]
    assert await _run_count(pg_url, conversation_id) == 3


async def test_regenerate_with_empty_content_is_unprocessable(app: FastAPI, pg_url: str) -> None:

    async with make_client(app) as client:
        await login_as_editor(client, pg_url)
        conversation_id = await new_conversation(client, AGENT_ID)
        await _send(client, conversation_id, "prm_empty", "问")
        await settled(client, conversation_id)

        empty = await client.post(
            f"/conversations/{conversation_id}/turns/t1:regenerate", json={"content": []}
        )

    assert empty.status_code == 422


async def test_regenerate_while_busy_is_conflict(app: FastAPI, pg_url: str) -> None:

    async with make_client(app) as client:
        await login_as_editor(client, pg_url)
        conversation_id = await new_conversation(client, AGENT_ID)
        await _send(client, conversation_id, "prm_busy1", "问")
        await _send(client, conversation_id, "prm_busy2", "再问")

        refused_running = await client.post(f"/conversations/{conversation_id}/turns/t1:regenerate")
        refused_queued = await client.post(f"/conversations/{conversation_id}/turns/t2:regenerate")
        await settled(client, conversation_id)

    assert refused_running.status_code == 409
    assert refused_queued.status_code == 409


async def test_regenerate_an_older_turn_is_conflict(app: FastAPI, pg_url: str) -> None:

    async with make_client(app) as client:
        await login_as_editor(client, pg_url)
        conversation_id = await new_conversation(client, AGENT_ID)
        await _send(client, conversation_id, "prm_old", "第一问")
        await settled(client, conversation_id)
        await _send(client, conversation_id, "prm_new", "第二问")
        await settled(client, conversation_id)

        refused_older = await client.post(f"/conversations/{conversation_id}/turns/t1:regenerate")
        refused_beyond = await client.post(f"/conversations/{conversation_id}/turns/t3:regenerate")

    assert refused_older.status_code == 409
    assert refused_beyond.status_code == 409


async def test_regenerate_in_someone_elses_conversation_is_not_found(
    app: FastAPI, pg_url: str
) -> None:
    """他人会话返回 404，避免泄漏资源存在性。"""

    async with make_client(app) as client:
        await login_as_editor(client, pg_url)
        mine = await new_conversation(client, AGENT_ID)
        await _send(client, mine, "prm_mine", "问")
        await settled(client, mine)

        async with make_client(app) as other:
            await register_and_login(other, username="max", email="max@example.com")
            await set_roles_in_db(pg_url, "max@example.com", ["editor"])
            crossed = await other.post(f"/conversations/{mine}/turns/t1:regenerate")

    assert crossed.status_code == 404


async def test_regenerate_with_a_malformed_turn_id_is_unprocessable(
    app: FastAPI, pg_url: str
) -> None:

    async with make_client(app) as client:
        await login_as_editor(client, pg_url)
        conversation_id = await new_conversation(client, AGENT_ID)
        await _send(client, conversation_id, "prm_shape", "问")
        await settled(client, conversation_id)

        not_a_turn = await client.post(f"/conversations/{conversation_id}/turns/abc:regenerate")
        zero = await client.post(f"/conversations/{conversation_id}/turns/t0:regenerate")

    assert not_a_turn.status_code == 422
    assert zero.status_code == 422


# --- 半途失败：占位、复核、截断任何一步失败，原历史都保持原样 ----------------------


@dataclass(frozen=True)
class _Answered:
    """跑完一轮的一段对话（问「第一问」、答「答：第一问」），和接在同一套存储上的 runner。"""

    engine: AsyncEngine
    runner: ConversationRunner
    step_store: PgStepStore
    queue: JobQueue
    store: TranscriptStore
    conversation_id: str

    def service(
        self,
        *,
        queue: JobQueue | None = None,
        history: TranscriptHistory | None = None,
        record_materials: Callable[
            [uuid.UUID, str, Sequence[PromptContent]], Awaitable[None]
        ] = records_nothing,
    ) -> TranscriptService:
        return TranscriptService(
            store=self.store,
            history=history or TranscriptHistory(self.step_store, self.queue),
            queue=queue or self.queue,
            runner=self.runner,
            context_limits={AGENT_ID: MAX_CONTEXT_TOKENS},
            record_materials=record_materials,
        )

    async def snapshot_count(self) -> int:
        async with self.engine.connect() as conn:
            return (
                await conn.execute(
                    text(
                        "SELECT count(*) FROM agent_runtime.snapshots WHERE conversation_id = :cid"
                    ),
                    {"cid": self.conversation_id},
                )
            ).scalar_one()

    async def assert_untouched(self, snapshots: int) -> None:
        """末轮还在：没写截断快照，历史仍是那一问一答，实时流里也没发删轮。"""

        assert await self.snapshot_count() == snapshots
        turns = (
            await TranscriptHistory(self.step_store, self.queue).read(self.conversation_id)
        ).turns
        assert [prompt_text(turn) for turn in turns] == ["第一问"]
        answer = turns[0].steps[0].frames[0]
        assert isinstance(answer, TextFrame)
        assert answer.text == "答：第一问"
        epoch = self.store.subscribe_view(self.conversation_id, MAIN_AGENT_ID).epoch
        journal = self.store.subscribe_view(
            self.conversation_id, MAIN_AGENT_ID, since=0, epoch=epoch
        ).batches
        assert not any(isinstance(op, ItemsRemoveOp) for batch in journal for op in batch.ops)

    async def assert_withdrawn(self, prompt_id: str) -> None:
        """占过执行位的那条没开跑就撤了；会话的最近一轮结局仍是原来那一轮。"""

        row = await self.queue.get(prompt_id)
        assert row is not None
        assert (row.status, row.run_id) == ("aborted", None)
        assert row.finished_at is not None
        view = await self.queue.view(self.conversation_id)
        assert view.active is None
        assert await self.queue.activities([self.conversation_id]) == {
            self.conversation_id: ActivityState(busy=False, last_turn_reason="completed")
        }


@pytest.fixture
async def answered(engine: AsyncEngine) -> AsyncIterator[_Answered]:
    store = TranscriptStore()
    runner, step_store, queue = build_runner(engine, says("答：第一问"), store=store)
    conversation_id = new_conversation_id()
    await submit_text(runner, queue, conversation_id, "第一问")
    await drained(queue, conversation_id)
    yield _Answered(
        engine=engine,
        runner=runner,
        step_store=step_store,
        queue=queue,
        store=store,
        conversation_id=conversation_id,
    )
    await runner.shutdown()


class _InsertFails(JobQueue):
    async def submit(
        self,
        *,
        prompt_id: str,
        conversation_id: str,
        agent_id: str,
        owner_user_id: uuid.UUID,
        user_name: str,
        content: tuple[PromptContent, ...],
        now: datetime,
        locked_by: str,
    ) -> Submission:
        raise RuntimeError("插入消息时库断了")


class _ViewBeforeTheOtherRun(JobQueue):
    """空闲检查读到的是别人开跑之前的那一刻。"""

    async def view(self, conversation_id: str) -> JobQueueView:
        return JobQueueView(active=None, queued=())


class _SnapshotsMustNotBeWritten(PgStepStore):
    async def save_snapshot(self, snapshot: ContinuableSnapshot) -> None:
        raise AssertionError("复核没过还写了截断快照")


class _SnapshotWriteFails(PgStepStore):
    async def save_snapshot(self, snapshot: ContinuableSnapshot) -> None:
        raise RuntimeError("写截断快照时库断了")


@dataclass(frozen=True, kw_only=True)
class _Replanned(TranscriptHistory):
    """第一次照常规划；持位复核那一次换成 ``second`` 给的计划，模拟占位前后之间发生的事。"""

    second: Callable[[TurnRewind], TurnRewind | None]
    planned: list[TurnRewind | None] = field(default_factory=list[TurnRewind | None])

    async def plan_rewind(self, conversation_id: str, *, ordinal: int) -> TurnRewind | None:
        plan = await super().plan_rewind(conversation_id, ordinal=ordinal)
        self.planned.append(plan)
        if len(self.planned) == 1 or plan is None:
            return plan
        return self.second(plan)


async def test_a_bad_attachment_is_refused_before_anything_is_written(
    answered: _Answered,
) -> None:
    """附件不合规在截断之前就拒：不登记素材、不插消息、不动历史。"""

    recorded: list[Sequence[PromptContent]] = []

    async def record(_owner: uuid.UUID, _cid: str, content: Sequence[PromptContent]) -> None:
        recorded.append(content)

    snapshots = await answered.snapshot_count()
    with pytest.raises(ValidationFailed):
        await answered.service(record_materials=record).regenerate(
            conversation_id=answered.conversation_id,
            turn_id="t1",
            prompt_id="prm_regen_bad",
            content=(
                TextContent(text="配这张图再答"),
                ImageContent(source=AttachmentSource(kind="file", file_id="f1")),
            ),
        )

    assert recorded == []
    assert await answered.queue.get("prm_regen_bad") is None
    await answered.assert_untouched(snapshots)


async def test_a_failed_insert_leaves_the_last_turn_alone(answered: _Answered) -> None:

    snapshots = await answered.snapshot_count()
    with pytest.raises(RuntimeError, match="插入消息时库断了"):
        await answered.service(queue=_InsertFails(answered.engine)).regenerate(
            conversation_id=answered.conversation_id, turn_id="t1", prompt_id="prm_regen_down"
        )

    assert await answered.queue.get("prm_regen_down") is None
    await answered.assert_untouched(snapshots)


async def test_losing_the_slot_to_another_run_withdraws_the_regeneration(
    answered: _Answered,
) -> None:
    """空闲检查之后别人先开跑了：这条只能排在后面，撤掉它，不让它在没截断的历史上跑。"""

    await answered.queue.submit(
        prompt_id="prm_first",
        conversation_id=answered.conversation_id,
        agent_id=AGENT_ID,
        owner_user_id=OWNER,
        user_name="logan",
        content=(TextContent(text="抢先一步"),),
        now=datetime.now(UTC),
        locked_by="w-other",
    )
    snapshots = await answered.snapshot_count()

    with pytest.raises(Conflict):
        await answered.service(queue=_ViewBeforeTheOtherRun(answered.engine)).regenerate(
            conversation_id=answered.conversation_id, turn_id="t1", prompt_id="prm_regen_late"
        )

    late = await answered.queue.get("prm_regen_late")
    assert late is not None
    assert (late.status, late.run_id) == ("aborted", None)
    first = await answered.queue.get("prm_first")
    assert first is not None
    assert (first.status, first.locked_by) == ("running", "w-other")
    await answered.assert_untouched(snapshots)


@pytest.mark.parametrize("change", ["another-turn", "replaced"])
async def test_a_last_turn_that_changed_before_the_slot_was_taken_is_left_alone(
    answered: _Answered, change: str
) -> None:
    """占位之前算的截断计划过时了：放开执行位、不截断。

    ``another-turn``：期间又跑完一轮，要重跑的已不是末轮；``replaced``：期间另一次重新生成把末轮换成了
    别的运行，照旧计划截断会截掉它的结果，所以复核不过时绝不能写快照。
    """

    engine = answered.engine

    def second(plan: TurnRewind) -> TurnRewind | None:
        if change == "another-turn":
            return None
        return replace(plan, run_ids=("r-somebody-else",), store=_SnapshotsMustNotBeWritten(engine))

    history = _Replanned(answered.step_store, answered.queue, second=second)
    snapshots = await answered.snapshot_count()

    with pytest.raises(Conflict):
        await answered.service(history=history).regenerate(
            conversation_id=answered.conversation_id, turn_id="t1", prompt_id="prm_regen_stale"
        )

    assert len(history.planned) == 2
    await answered.assert_withdrawn("prm_regen_stale")
    await answered.assert_untouched(snapshots)


async def test_a_failed_truncation_withdraws_the_regeneration(answered: _Answered) -> None:
    """写截断快照失败：放开执行位，错误原样交给调用方，原历史不动。"""

    engine = answered.engine
    history = _Replanned(
        answered.step_store,
        answered.queue,
        second=lambda plan: replace(plan, store=_SnapshotWriteFails(engine)),
    )
    snapshots = await answered.snapshot_count()

    with pytest.raises(RuntimeError, match="写截断快照时库断了"):
        await answered.service(history=history).regenerate(
            conversation_id=answered.conversation_id, turn_id="t1", prompt_id="prm_regen_torn"
        )

    await answered.assert_withdrawn("prm_regen_torn")
    await answered.assert_untouched(snapshots)
