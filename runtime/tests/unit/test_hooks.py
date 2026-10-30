"""回调应用：开跑检查答 2xx 才放行，非 2xx、超时、连不上都抛 ``HookRejected``；运行与轮次开始失败只记日志。
请求按会话归属的应用找地址，带令牌与 JSON 请求体；应用没配的回调不发。"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import AsyncGenerator, Callable

import httpx
import pytest

from agent_runtime.hooks import (
    AppHooks,
    GatePayload,
    HookRejected,
    RunStartedPayload,
    TurnStartedPayload,
)
from agent_runtime.settings import ResolvedHooks
from agent_runtime.transcript.wire import SessionActivityOut

SESSION = uuid.UUID("0b8e9f4c-6a1d-4f2e-9c3b-5d7a1e2f3c4d")
QUIET_SESSION = uuid.UUID("1a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d")
OWNER = uuid.UUID("6f1d8a4e-2b7c-4e0a-9d51-3c2f7e8b9a10")
TOKEN = "hook-token-0123456789-0123456789-xyz"

BFF_HOOKS = ResolvedHooks(
    token=TOKEN,
    gate="https://bff.test/hooks/gate",
    run_started="https://bff.test/hooks/run-started",
    turn_started="https://bff.test/hooks/turn-started",
    timeout_seconds=0.2,
)

Handler = Callable[[httpx.Request], httpx.Response]


def raising(error: Exception) -> Handler:
    def answer(_request: httpx.Request) -> httpx.Response:
        raise error

    return answer


async def app_of(session_id: str) -> str | None:
    return {str(SESSION): "bff", str(QUIET_SESSION): "quiet"}.get(session_id)


class Recorder:
    """记下收到的请求，按 ``answer`` 答复；``answer`` 可以抛异常模拟连不上或超时。"""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.answer: Handler = lambda _request: httpx.Response(204)

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.answer(request)


@pytest.fixture
def recorder() -> Recorder:
    return Recorder()


@pytest.fixture
async def hooks(recorder: Recorder) -> AsyncGenerator[AppHooks]:
    async with httpx.AsyncClient(transport=httpx.MockTransport(recorder)) as client:
        yield AppHooks(hooks={"bff": BFF_HOOKS}, app_of=app_of, client=client)


def gate_payload(session: uuid.UUID = SESSION) -> GatePayload:
    return GatePayload(
        session_id=session, owner_user_id=OWNER, user_name="logan", prompt_id="prm_1"
    )


def run_payload() -> RunStartedPayload:
    return RunStartedPayload(
        session_id=SESSION,
        run_id="director-1a2b3c4d",
        activity=SessionActivityOut(busy=True, pending_interaction="none"),
    )


async def test_the_gate_posts_the_payload_with_the_token(
    hooks: AppHooks, recorder: Recorder
) -> None:
    await hooks.gate(gate_payload())

    (request,) = recorder.requests
    assert (request.method, str(request.url)) == ("POST", BFF_HOOKS.gate)
    assert request.headers["authorization"] == f"Bearer {TOKEN}"
    assert json.loads(request.content) == {
        "session_id": str(SESSION),
        "owner_user_id": str(OWNER),
        "user_name": "logan",
        "prompt_id": "prm_1",
        "run_id": None,
    }


@pytest.mark.parametrize("status", [403, 500, 302])
async def test_a_non_2xx_gate_answer_rejects_the_run(
    hooks: AppHooks, recorder: Recorder, status: int
) -> None:
    recorder.answer = lambda _request: httpx.Response(status)

    with pytest.raises(HookRejected, match=str(status)):
        await hooks.gate(gate_payload())


@pytest.mark.parametrize(
    "error", [httpx.ReadTimeout("慢"), httpx.ConnectError("连不上")], ids=["timeout", "connect"]
)
async def test_a_gate_that_does_not_answer_rejects_the_run(
    hooks: AppHooks, recorder: Recorder, error: httpx.HTTPError
) -> None:
    recorder.answer = raising(error)

    with pytest.raises(HookRejected):
        await hooks.gate(gate_payload())


async def test_a_gate_slower_than_the_timeout_rejects_the_run() -> None:
    """传输层不掐超时（替身、代理）时也按 ``timeout_seconds`` 算。"""

    async def slow(_request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(5)
        return httpx.Response(204)

    async with httpx.AsyncClient(transport=httpx.MockTransport(slow)) as client:
        hooks = AppHooks(hooks={"bff": BFF_HOOKS}, app_of=app_of, client=client)
        with pytest.raises(HookRejected):
            await hooks.gate(gate_payload())


async def test_apps_without_a_gate_are_not_called(hooks: AppHooks, recorder: Recorder) -> None:
    await hooks.gate(gate_payload(QUIET_SESSION))
    await hooks.run_started(run_payload().model_copy(update={"session_id": QUIET_SESSION}))

    assert recorder.requests == []


async def test_a_session_nobody_owns_fails_the_gate(hooks: AppHooks, recorder: Recorder) -> None:
    with pytest.raises(HookRejected):
        await hooks.gate(gate_payload(uuid.uuid4()))
    assert recorder.requests == []


async def test_run_started_posts_the_activity(hooks: AppHooks, recorder: Recorder) -> None:
    await hooks.run_started(run_payload())

    (request,) = recorder.requests
    assert str(request.url) == BFF_HOOKS.run_started
    assert json.loads(request.content) == {
        "session_id": str(SESSION),
        "run_id": "director-1a2b3c4d",
        "activity": {"busy": True, "pending_interaction": "none", "last_turn_reason": None},
    }


async def test_turn_started_posts_the_text(hooks: AppHooks, recorder: Recorder) -> None:
    await hooks.turn_started(TurnStartedPayload(session_id=SESSION, text="第一问"))

    (request,) = recorder.requests
    assert str(request.url) == BFF_HOOKS.turn_started
    assert json.loads(request.content) == {"session_id": str(SESSION), "text": "第一问"}


def server_error(_request: httpx.Request) -> httpx.Response:
    return httpx.Response(500)


@pytest.mark.parametrize(
    "answer",
    [
        server_error,
        raising(httpx.ReadTimeout("慢")),
        raising(httpx.ConnectError("连不上")),
    ],
    ids=["500", "timeout", "connect"],
)
async def test_run_and_turn_notifications_swallow_failures(
    hooks: AppHooks, recorder: Recorder, answer: Handler
) -> None:
    recorder.answer = answer

    await hooks.run_started(run_payload())
    await hooks.turn_started(TurnStartedPayload(session_id=SESSION, text="第一问"))

    assert len(recorder.requests) == 2
