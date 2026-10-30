"""运行时服务测试的常量、替身与驱动：两个应用的密钥（一个有管理权限）、两个测试插件，经管理接口接入供应商与
发布 agent，经会话接口等一段会话跑完。"""

from __future__ import annotations

import asyncio
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import httpx
from agent_runtime.plugins.base import CapPlugin
from agent_runtime.transcript.display import DisplayFn, ToolDisplayEntry
from pydantic_ai import Tool
from pydantic_ai.capabilities import Capability

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


__all__ = [
    "ADMIN_KEY",
    "PROVIDER",
    "READER_KEY",
    "ApprovingPlugin",
    "LimitedPlugin",
    "add_model",
    "connect_provider",
    "publish_agent",
    "settled",
]
