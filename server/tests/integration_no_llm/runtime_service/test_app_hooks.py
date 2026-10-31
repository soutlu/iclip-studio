"""运行时回调应用：开跑检查不放行这次运行失败，原因记在消息行上，应用暂时不在（没答复、答 502/503/504）先在
窗口里重试；运行开始在这次运行的第一批操作之前调到；轮次开始每轮一次，审批续跑不算；没配回调的应用一次都
不调。回调经 ``HookRecorder`` 接住。"""

from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator

import httpx
import pytest
from agent_runtime.harness.jobs import JobRow
from agent_runtime.harness.transcript.store import TranscriptStore
from agent_runtime.hooks import AppHooks, GatePayload
from agent_runtime.settings import ResolvedHooks
from pydantic_ai.models import Model
from sqlalchemy.ext.asyncio import AsyncEngine

from tests.helpers.app import TEST_MODEL_NAME
from tests.helpers.runtime import build_runner, calls_then_says, drained, says, submit_text
from tests.helpers.runtime_service import (
    ADMIN_KEY,
    HOOK_TOKEN,
    READER_HOOKS,
    HookRecorder,
    LiveRuntime,
    receive,
    subscribe,
)


@pytest.fixture
def models() -> dict[str, Model]:
    return {TEST_MODEL_NAME: says("答：走起来", "答：再来")}


@pytest.fixture
def reader_hooks() -> ResolvedHooks | None:
    return READER_HOOKS


def test_the_gate_is_called_with_the_prompt_and_lets_the_run_through(
    live: LiveRuntime, hook_recorder: HookRecorder
) -> None:
    session = live.open_session()
    live.send(session, "prm_gate")
    live.settled(session)

    assert live.status(session) == "completed"
    assert hook_recorder.named("gate") == [
        {
            "session_id": session,
            "owner_user_id": str(live.owner),
            "user_name": "logan",
            "prompt_id": "prm_gate",
            "run_id": None,
        }
    ]
    assert set(hook_recorder.tokens) == {f"Bearer {HOOK_TOKEN}"}


def test_a_gate_that_does_not_let_it_through_fails_the_run(
    live: LiveRuntime, hook_recorder: HookRecorder
) -> None:
    hook_recorder.answers["gate"] = lambda: httpx.Response(403)
    session = live.open_session()

    live.send(session, "prm_refused")
    live.settled(session)

    assert live.status(session) == "failed"
    assert [body["prompt_id"] for body in hook_recorder.named("gate")] == ["prm_refused"]


# --- 开跑检查接在运行驱动上：应用暂时不在就重试，没放行的原因记在消息行上 -----------------


async def reader_app(_session_id: str) -> str:
    return "reader"


@pytest.fixture
async def quick_gate(hook_recorder: HookRecorder) -> AsyncGenerator[AppHooks]:
    """回调经 ``hook_recorder`` 接住、重试退避缩到几十毫秒的开跑检查。"""

    async with httpx.AsyncClient(transport=httpx.MockTransport(hook_recorder)) as client:
        yield AppHooks(
            hooks={"reader": READER_HOOKS},
            app_of=reader_app,
            client=client,
            first_retry_seconds=0.01,
            max_retry_seconds=0.02,
            retry_window_seconds=0.1,
        )


async def run_through_gate(engine: AsyncEngine, gate: AppHooks) -> JobRow:
    """照组合根的接法把开跑检查接在运行依赖构造上，跑完一条消息，交回它的消息行。"""

    async def deps_for(row: JobRow) -> None:
        await gate.gate(
            GatePayload(
                session_id=uuid.UUID(row.conversation_id),
                owner_user_id=row.owner_user_id,
                user_name=row.user_name,
                prompt_id=row.prompt_id,
                run_id=row.run_id,
            )
        )

    runner, _store, queue = build_runner(
        engine, says("答：走起来"), store=TranscriptStore(), deps_for=deps_for
    )
    conversation_id = str(uuid.uuid4())
    prompt_id = await submit_text(runner, queue, conversation_id, "开始")
    await drained(queue, conversation_id)
    await runner.shutdown()
    row = await queue.get(prompt_id)
    assert row is not None
    return row


def no_answer() -> httpx.Response:
    raise httpx.ConnectError("后端在重启")


async def test_the_run_goes_ahead_once_a_temporarily_absent_gate_answers(
    engine: AsyncEngine, quick_gate: AppHooks, hook_recorder: HookRecorder
) -> None:
    answers = iter([no_answer, lambda: httpx.Response(503), lambda: httpx.Response(204)])
    hook_recorder.answers["gate"] = lambda: next(answers)()

    row = await run_through_gate(engine, quick_gate)

    assert (row.status, row.interrupt_reason) == ("completed", None)
    assert len(hook_recorder.named("gate")) == 3


async def test_a_forbidding_gate_fails_the_run_at_once_with_the_reason(
    engine: AsyncEngine, quick_gate: AppHooks, hook_recorder: HookRecorder
) -> None:
    hook_recorder.answers["gate"] = lambda: httpx.Response(403)

    row = await run_through_gate(engine, quick_gate)

    assert row.status == "failed"
    assert row.interrupt_reason is not None
    assert "答了 403" in row.interrupt_reason
    assert len(hook_recorder.named("gate")) == 1


async def test_a_gate_that_never_answers_fails_the_run_after_the_window_with_the_reason(
    engine: AsyncEngine, quick_gate: AppHooks, hook_recorder: HookRecorder
) -> None:
    hook_recorder.answers["gate"] = no_answer

    row = await run_through_gate(engine, quick_gate)

    assert row.status == "failed"
    assert row.interrupt_reason is not None
    assert "没有答复" in row.interrupt_reason


def test_run_started_comes_before_the_runs_first_ops(
    live: LiveRuntime, hook_recorder: HookRecorder
) -> None:
    session = live.open_session()

    with live.connect("/v1/ws") as ws:
        subscribe(ws, session)
        receive(ws, "ack")
        live.send(session, "prm_order")
        # 受理时那批只有 prompt.upsert；运行自己产出的第一批带 turn.upsert。
        for _ in range(60):
            frame = receive(ws, "transcript.ops")
            if any(op["op"] == "turn.upsert" for op in frame["payload"]["ops"]):
                break
        else:
            raise AssertionError("没等到运行的第一批操作")
        seen_before_first_ops = list(hook_recorder.named("run-started"))
    live.settled(session)

    (started,) = seen_before_first_ops
    assert started["session_id"] == session
    assert started["run_id"].startswith(f"{live.agent}-")
    assert started["activity"] == {
        "busy": True,
        "pending_interaction": "none",
        "last_turn_reason": None,
    }


def test_apps_without_hooks_are_never_called(
    live: LiveRuntime, hook_recorder: HookRecorder
) -> None:
    session = live.open_session(ADMIN_KEY)

    live.send(session, "prm_quiet", key=ADMIN_KEY)
    live.settled(session, ADMIN_KEY)

    assert hook_recorder.calls == []


class TestTurnStarted:
    @pytest.fixture
    def models(self) -> dict[str, Model]:
        return {TEST_MODEL_NAME: calls_then_says("write_file", "改完了")}

    @pytest.fixture
    def live_agent_plugins(self) -> tuple[str, ...]:
        return ("approving",)

    def test_is_called_once_per_turn_and_not_on_continuations(
        self, live: LiveRuntime, hook_recorder: HookRecorder
    ) -> None:
        session = live.open_session()
        live.send(session, "prm_first", text="第一问")
        live.reaches(session, "awaiting")
        page = live.tc.get(
            f"/v1/sessions/{session}/transcript",
            params={"session_agent": live.agent},
            headers=live.headers(),
        )
        (interaction,) = page.json()["pending_interactions"]
        approved = live.tc.post(
            f"/v1/sessions/{session}/interactions/{interaction}",
            json={"approved": True},
            headers=live.headers(),
        )
        assert approved.status_code == 204, approved.text
        live.settled(session)
        hook_recorder.waits_for("turn-started", 1)
        # 审批续跑是同一轮的第二次运行：运行开始调两次，轮次开始只调一次。
        assert len(hook_recorder.named("run-started")) == 2
        assert hook_recorder.named("turn-started") == [{"session_id": session, "text": "第一问"}]

        live.send(session, "prm_second", text="第二问")
        live.settled(session)
        hook_recorder.waits_for("turn-started", 2)

        assert [body["text"] for body in hook_recorder.named("turn-started")] == [
            "第一问",
            "第二问",
        ]
        assert len(hook_recorder.named("gate")) == 3
