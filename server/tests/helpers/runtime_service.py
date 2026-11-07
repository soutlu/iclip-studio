from __future__ import annotations

import asyncio
import json
import time
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Self

import httpx
from cue.file_store.namespace import namespace_for
from cue.file_store.store import FileStore
from cue.plugins.base import CapPlugin
from cue.run_deps import AgentRunDeps
from cue.settings import ResolvedHooks
from cue.transcript.display import DisplayFn, ToolDisplayEntry
from fastapi import FastAPI
from pydantic_ai import RunContext, Tool
from pydantic_ai.capabilities import Capability
from starlette.testclient import TestClient

from tests.helpers.app import TEST_MODEL_NAME
from tests.helpers.model_providers import GOOD_KEY
from tests.helpers.runtime import wrote

ADMIN_KEY = "runtime-admin-key-0123456789-abcdefg"

READER_KEY = "runtime-reader-key-0123456789-abcdef"

PROVIDER = "bailian-main"


@dataclass
class LimitedPlugin(CapPlugin[Any]):
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


@dataclass
class ApprovingPlugin(CapPlugin[Any]):
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
    for _ in range(tries):
        queue = await client.get(f"/sessions/{session_id}/prompts")
        assert queue.status_code == 200, queue.text
        if queue.json()["active"] is None and not queue.json()["queued"]:
            return
        await asyncio.sleep(0.02)
    raise AssertionError("这段会话没跑完")


@dataclass(frozen=True)
class LiveRuntime:
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
        return self.tc.websocket_connect(path, headers={"Authorization": f"Bearer {key}"})


def receive(ws: Any, kind: str, *, tries: int = 60) -> dict[str, Any]:
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
