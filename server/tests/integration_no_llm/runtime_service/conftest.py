"""运行时服务的夹具：经 ``httpx.ASGITransport`` 挂上运行时服务，接迁移好的测试库。

配置表现在仍有指向 ``iclip.users`` 的外键、建表也在后端的迁移里，所以这些用例放在后端的集成层；
``X-End-User`` 用的是种进库里的真实用户。插件登记表默认只有一个测试插件 ``limited``，模型按名字换成
集成层 ``models`` 夹具给的替身。

``ASGITransport`` 不跑 lifespan：要让消息真跑起来的用例另取 ``running``，它起停运行驱动。
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator, Mapping
from pathlib import Path

import httpx
import pytest
from agent_runtime.http import create_app
from agent_runtime.plugins.base import PluginRegistry
from agent_runtime.settings import (
    AgentRunsSection,
    CompactionSection,
    ResolvedApp,
    RuntimeSettings,
)
from fastapi import FastAPI
from pydantic_ai.models import Model
from sqlalchemy.ext.asyncio import AsyncEngine

from tests.helpers.agents import model_builder
from tests.helpers.app import TEST_CREDENTIAL_KEY
from tests.helpers.model_providers import GOOD_KEY, KeyCheckingProbe
from tests.helpers.references import plant_user
from tests.helpers.runtime_service import ADMIN_KEY, READER_KEY, LimitedPlugin


@pytest.fixture
def plugin_registry() -> PluginRegistry:
    """测试可覆写：交给运行时服务的插件登记表。"""

    return {"limited": LimitedPlugin}


@pytest.fixture
def runtime_app(
    engine: AsyncEngine,
    migrated_pg: str,
    tmp_path: Path,
    plugin_registry: PluginRegistry,
    models: Mapping[str, Model],
) -> FastAPI:
    settings = RuntimeSettings(
        database_url=migrated_pg,
        credential_encryption_keys=(TEST_CREDENTIAL_KEY,),
        apps=(
            ResolvedApp(id="bff", key=ADMIN_KEY, admin=True),
            ResolvedApp(id="reader", key=READER_KEY, admin=False),
        ),
        agent_runs=AgentRunsSection(skill_cache_dir=tmp_path / "skills"),
        compaction=CompactionSection(),
        log_level="WARNING",
        log_format="console",
    )
    return create_app(
        settings,
        plugins=plugin_registry,
        credential_probe=KeyCheckingProbe({GOOD_KEY}),
        engine=engine,
        build_model=model_builder(models),
    )


@pytest.fixture
async def running(runtime_app: FastAPI) -> AsyncGenerator[None]:
    """跑运行时服务的 lifespan：运行驱动起来，用例结束时关停。"""

    async with runtime_app.router.lifespan_context(runtime_app):
        yield


@pytest.fixture
async def actor(engine: AsyncEngine) -> uuid.UUID:
    """代办用户：库里的一个真实账号，作者列有外键指向它。"""

    return await plant_user(engine, "runtime-admin")


@pytest.fixture
async def owner(engine: AsyncEngine) -> uuid.UUID:
    """会话的属主：库里的另一个真实账号。"""

    return await plant_user(engine, "session-owner")


@pytest.fixture
async def anonymous(runtime_app: FastAPI) -> AsyncGenerator[httpx.AsyncClient]:
    """不带任何请求头的客户端。"""

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=runtime_app), base_url="http://runtime.test"
    ) as client:
        yield client


@pytest.fixture
async def admin(runtime_app: FastAPI, actor: uuid.UUID) -> AsyncGenerator[httpx.AsyncClient]:
    """有管理权限的应用，代 ``actor`` 操作；路径相对 ``/v1/admin``。"""

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=runtime_app),
        base_url="http://runtime.test/v1/admin",
        headers={"Authorization": f"Bearer {ADMIN_KEY}", "X-End-User": str(actor)},
    ) as client:
        yield client


@pytest.fixture
async def app_client(runtime_app: FastAPI, owner: uuid.UUID) -> AsyncGenerator[httpx.AsyncClient]:
    """没有管理权限的应用，``X-End-User`` 是 ``owner``；路径相对 ``/v1``。"""

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=runtime_app),
        base_url="http://runtime.test/v1",
        headers={"Authorization": f"Bearer {READER_KEY}", "X-End-User": str(owner)},
    ) as client:
        yield client
