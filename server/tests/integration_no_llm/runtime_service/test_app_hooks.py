"""运行时回调应用：开跑检查不放行（非 2xx、超时）这次运行失败；运行开始在这次运行的第一批操作之前调到；
轮次开始每轮一次，审批续跑不算；没配回调的应用一次都不调。回调经 ``HookRecorder`` 接住。"""

from __future__ import annotations

from typing import Any

import httpx
import pytest
from agent_runtime.settings import ResolvedHooks
from pydantic_ai.models import Model

from tests.helpers.app import TEST_MODEL_NAME
from tests.helpers.runtime import calls_then_says, says
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


def answer_timeout() -> httpx.Response:
    raise httpx.ReadTimeout("开跑检查太慢")


@pytest.mark.parametrize(
    "answer",
    [lambda: httpx.Response(403), answer_timeout],
    ids=["forbidden", "timeout"],
)
def test_a_gate_that_does_not_let_it_through_fails_the_run(
    live: LiveRuntime, hook_recorder: HookRecorder, answer: Any
) -> None:
    hook_recorder.answers["gate"] = answer
    session = live.open_session()

    live.send(session, "prm_refused")
    live.settled(session)

    assert live.status(session) == "failed"
    assert [body["prompt_id"] for body in hook_recorder.named("gate")] == ["prm_refused"]


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
