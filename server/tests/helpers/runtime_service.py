from __future__ import annotations

import asyncio
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Self

import httpx
from agent_runtime.file_store.namespace import namespace_for
from agent_runtime.file_store.store import FileStore
from agent_runtime.plugins.base import CapPlugin
from agent_runtime.run_deps import AgentRunDeps
from agent_runtime.transcript.display import DisplayFn, ToolDisplayEntry
from pydantic_ai import RunContext, Tool
from pydantic_ai.capabilities import Capability

from tests.helpers.app import TEST_MODEL_NAME
from tests.helpers.model_providers import GOOD_KEY

ADMIN_KEY = "runtime-admin-key-0123456789-abcdefg"

READER_KEY = "runtime-reader-key-0123456789-abcdef"

PROVIDER = "bailian-main"


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


__all__ = [
    "ADMIN_KEY",
    "JOTTED",
    "PROVIDER",
    "READER_KEY",
    "JottingPlugin",
    "add_model",
    "connect_provider",
    "publish_agent",
    "settled",
]
