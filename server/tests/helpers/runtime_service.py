"""运行时服务测试的常量、替身与驱动：两个应用的密钥（一个有管理权限）、三个测试插件，经管理接口接入供应商与
发布 agent，经会话接口等一段会话跑完；跑着 lifespan 的服务用同步 ``TestClient`` 驱动 WebSocket，回调由
``HookRecorder`` 接住。"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Self

import httpx
from agent_runtime.file_store.namespace import namespace_for
from agent_runtime.file_store.store import FileStore
from agent_runtime.plugins.base import CapPlugin
from agent_runtime.run_deps import AgentRunDeps
from agent_runtime.settings import ResolvedHooks
from agent_runtime.transcript.display import DisplayFn, ToolDisplayEntry
from fastapi import FastAPI
from pydantic_ai import RunContext, Tool
from pydantic_ai.capabilities import Capability
from starlette.testclient import TestClient

from tests.helpers.app import TEST_MODEL_NAME
from tests.helpers.model_providers import GOOD_KEY
from tests.helpers.runtime import wrote

ADMIN_KEY = "runtime-admin-key-0123456789-abcdefg"
"""有管理权限的应用 ``bff`` 的密钥。"""

READER_KEY = "runtime-reader-key-0123456789-abcdef"
"""没有管理权限的应用 ``reader`` 的密钥。"""

PROVIDER = "bailian-main"
"""``connect_provider`` 接入的供应商引用名（按百炼声明）。"""


@dataclass
class LimitedPlugin(CapPlugin[Any]):
    """测试插件 ``limited``：带一个整数参数 ``limit``。"""

    label = "限量"
    summary = "测试用。"

    @classmethod
    def get_serialization_name(cls) -> str:
        return "limited"

    @classmethod
    def from_spec(cls, *, limit: int = 10) -> Capability[Any]:
        return Capability[Any](id="limited", instructions=f"最多 {limit} 条。")

    @classmethod
    def display_table(cls) -> Mapping[str, DisplayFn | ToolDisplayEntry]:
        return {}


@dataclass
class JottingPlugin(CapPlugin[Any]):
    """测试插件 ``jotting``：一件工具 ``jot``，往会话工作区写 ``notes.md``；用 ``bind`` 绑上运行时服务的
    工作区存储。"""

    label = "记一笔"
    summary = "测试用。"

    @classmethod
    def get_serialization_name(cls) -> str:
        return "jotting"

    @classmethod
    def bind(cls, *, files: FileStore) -> type[Self]:
        return cls._bound(files=files)

    @classmethod
    def from_spec(cls) -> Capability[Any]:
        files: FileStore = cls._bound_services()["files"]

        async def jot(ctx: RunContext[AgentRunDeps]) -> str:
            namespace = namespace_for(ctx.deps.user_id, ctx.deps.conversation_id)
            await files.write(namespace, JOTTED, "记一笔")
            return "记好了"

        return Capability[Any](id="jotting", tools=[Tool(jot, name="jot")])

    @classmethod
    def display_table(cls) -> Mapping[str, DisplayFn | ToolDisplayEntry]:
        return {}


JOTTED = "notes.md"
"""``jot`` 写的那份文件。"""


@dataclass
class ApprovingPlugin(CapPlugin[Any]):
    """测试插件 ``approving``：一件要审批才能动的工具 ``write_file``。"""

    label = "改文件"
    summary = "测试用。"

    @classmethod
    def get_serialization_name(cls) -> str:
        return "approving"

    @classmethod
    def from_spec(cls) -> Capability[Any]:
        return Capability[Any](
            id="approving", tools=[Tool(wrote, name="write_file", requires_approval=True)]
        )

    @classmethod
    def display_table(cls) -> Mapping[str, DisplayFn | ToolDisplayEntry]:
        return {}


async def connect_provider(admin: httpx.AsyncClient) -> str:
    """经管理接口接入供应商 ``PROVIDER`` 并加一把好密钥，交回供应商 id。"""

    provider = await admin.post(
        "/model-providers", json={"name": PROVIDER, "provider": "bailian", "label": "百炼"}
    )
    assert provider.status_code == 201, provider.text
    provider_id = str(provider.json()["id"])
    credential = await admin.post(
        f"/model-providers/{provider_id}/credentials",
        json={"name": "主账号", "fields": {"api_key": GOOD_KEY}},
    )
    assert credential.status_code == 201, credential.text
    return provider_id


async def add_model(admin: httpx.AsyncClient, provider_id: str, name: str) -> None:
    """给供应商加一个自己加的对话模型；运行时按模型名换成测试替身。"""

    added = await admin.post(
        f"/model-providers/{provider_id}/models", json={"name": name, "type": "llm", "api": "chat"}
    )
    assert added.status_code == 201, added.text


async def publish_agent(
    admin: httpx.AsyncClient,
    agent_id: str,
    *,
    model: str = TEST_MODEL_NAME,
    plugins: Sequence[str] = (),
    subagents: Sequence[str] = (),
    listed: bool = True,
) -> None:
    """经管理接口建 agent、存草稿、发布 v1；``listed`` 为真就上首页菜单。用到的模型要先加好。"""

    created = await admin.post("/agents", json={"id": agent_id, "name": agent_id})
    assert created.status_code == 201, created.text
    config = {
        "schema_version": 1,
        "instructions": "",
        "model": {"provider": PROVIDER, "name": model},
        "tools": [
            {"type": "cap", "toolset": name, "enabled": True, "parameters": {}} for name in plugins
        ],
        "subagents": [{"agent": name} for name in subagents],
    }
    saved = await admin.put(
        f"/agents/{agent_id}/draft",
        json={
            "config": config,
            "skillIds": [],
            "lockVersion": created.json()["draft"]["lockVersion"],
        },
    )
    assert saved.status_code == 200, saved.text
    published = await admin.post(
        f"/agents/{agent_id}/versions", json={"lockVersion": saved.json()["draft"]["lockVersion"]}
    )
    assert published.status_code == 201, published.text
    if listed:
        updated = await admin.patch(f"/agents/{agent_id}", json={"listed": True})
        assert updated.status_code == 200, updated.text


async def settled(client: httpx.AsyncClient, session_id: str, *, tries: int = 250) -> None:
    """等会话里在跑的与排着的都收完尾；``client`` 的路径相对 ``/v1``。"""

    for _ in range(tries):
        queue = await client.get(f"/sessions/{session_id}/prompts")
        assert queue.status_code == 200, queue.text
        if queue.json()["active"] is None and not queue.json()["queued"]:
            return
        await asyncio.sleep(0.02)
    raise AssertionError("这段会话没跑完")


# --- 跑着 lifespan 的服务（同步 TestClient，WebSocket 用） ------------------------


@dataclass(frozen=True)
class LiveRuntime:
    """跑着 lifespan 的运行时服务：同步 ``TestClient``、会话属主与已发布的 agent。

    ``reader`` 是被测的应用（回调只配在它上面），``bff`` 是另一个应用。"""

    tc: TestClient
    app: FastAPI
    owner: uuid.UUID
    agent: str

    def headers(self, key: str = READER_KEY) -> dict[str, str]:
        return {"Authorization": f"Bearer {key}", "X-End-User": str(self.owner)}

    def open_session(self, key: str = READER_KEY) -> str:
        session_id = str(uuid.uuid4())
        opened = self.tc.post(
            "/v1/sessions",
            json={"id": session_id, "agent_id": self.agent},
            headers=self.headers(key),
        )
        assert opened.status_code == 204, opened.text
        return session_id

    def send(
        self, session_id: str, prompt_id: str, text: str = "走", key: str = READER_KEY
    ) -> None:
        sent = self.tc.post(
            f"/v1/sessions/{session_id}/prompts",
            json={
                "prompt_id": prompt_id,
                "content": [{"type": "text", "text": text}],
                "user_name": "logan",
                "agent_id": self.agent,
            },
            headers=self.headers(key),
        )
        assert sent.status_code == 200, sent.text

    def status(self, session_id: str, key: str = READER_KEY) -> str:
        found = self.tc.get(f"/v1/sessions/{session_id}/status", headers=self.headers(key))
        assert found.status_code == 200, found.text
        return str(found.json()["status"])

    def settled(self, session_id: str, key: str = READER_KEY, *, tries: int = 250) -> None:
        for _ in range(tries):
            queue = self.tc.get(f"/v1/sessions/{session_id}/prompts", headers=self.headers(key))
            assert queue.status_code == 200, queue.text
            if queue.json()["active"] is None and not queue.json()["queued"]:
                return
            time.sleep(0.02)
        raise AssertionError("这段会话没跑完")

    def reaches(self, session_id: str, status: str, *, tries: int = 250) -> None:
        for _ in range(tries):
            if self.status(session_id) == status:
                return
            time.sleep(0.02)
        raise AssertionError(f"这段会话没到 {status}")

    def connect(self, path: str, key: str = READER_KEY) -> Any:
        """``/v1/ws`` 或 ``/v1/events`` 的连接（上下文管理器）。"""

        return self.tc.websocket_connect(path, headers={"Authorization": f"Bearer {key}"})


def receive(ws: Any, kind: str, *, tries: int = 60) -> dict[str, Any]:
    """等一帧 ``kind``，跳过期间的回执与心跳。"""

    for _ in range(tries):
        frame: dict[str, Any] = ws.receive_json()
        if frame.get("type") == kind:
            return frame
    raise AssertionError(f"没收到 {kind}")


def subscribe(
    ws: Any,
    session_id: str,
    *,
    grade: str = "delta",
    agent: str = "main",
    since: int | None = None,
    epoch: str | None = None,
    frame_id: str = "s1",
) -> None:
    payload: dict[str, Any] = {"session_id": session_id, "transcript": {agent: grade}}
    if since is not None:
        payload["transcript_since"] = {agent: since}
    if epoch is not None:
        payload["transcript_epoch"] = {agent: epoch}
    ws.send_json({"type": "subscribe_v2", "id": frame_id, "payload": payload})


def ops_until_turn_ends(ws: Any, *, tries: int = 60) -> list[dict[str, Any]]:
    """收 ``transcript.ops`` 帧，直到某帧里这一轮到了终态；低档会筛掉批次，不能按帧数等。"""

    frames: list[dict[str, Any]] = []
    for _ in range(tries):
        frame: dict[str, Any] = ws.receive_json()
        if frame.get("type") != "transcript.ops":
            continue
        frames.append(frame)
        if any(
            op["op"] == "turn.upsert" and op["turn"]["state"] != "running"
            for op in frame["payload"]["ops"]
        ):
            return frames
    raise AssertionError("这一轮没等到结束")


class HookRecorder:
    """接住运行时回调应用的请求：按路径最后一段（``gate`` / ``run-started`` / ``turn-started``）记下请求体
    与令牌，按 ``answers`` 答复，没给的答 204。在服务的事件循环里被调，测试线程只读。"""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.tokens: list[str] = []
        self.answers: dict[str, Callable[[], httpx.Response]] = {}

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        name = request.url.path.rsplit("/", 1)[-1]
        self.calls.append((name, json.loads(request.content)))
        self.tokens.append(request.headers.get("authorization", ""))
        answer = self.answers.get(name)
        return httpx.Response(204) if answer is None else answer()

    def named(self, name: str) -> list[dict[str, Any]]:
        return [body for called, body in self.calls if called == name]

    def waits_for(self, name: str, count: int, *, tries: int = 250) -> None:
        for _ in range(tries):
            if len(self.named(name)) >= count:
                return
            time.sleep(0.02)
        raise AssertionError(f"{name} 没被调够 {count} 次")


HOOK_TOKEN = "runtime-hook-token-0123456789-abcdef"
HOOK_BASE = "https://reader.test/hooks"

READER_HOOKS = ResolvedHooks(
    token=HOOK_TOKEN,
    gate=f"{HOOK_BASE}/gate",
    run_started=f"{HOOK_BASE}/run-started",
    turn_started=f"{HOOK_BASE}/turn-started",
    timeout_seconds=2.0,
)
"""被测应用 ``reader`` 的三个回调都配上。"""


__all__ = [
    "ADMIN_KEY",
    "HOOK_TOKEN",
    "JOTTED",
    "PROVIDER",
    "READER_HOOKS",
    "READER_KEY",
    "ApprovingPlugin",
    "HookRecorder",
    "JottingPlugin",
    "LimitedPlugin",
    "LiveRuntime",
    "add_model",
    "connect_provider",
    "ops_until_turn_ends",
    "publish_agent",
    "receive",
    "settled",
    "subscribe",
]
