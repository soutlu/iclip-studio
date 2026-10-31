"""运行时服务的夹具：经 ``httpx.ASGITransport`` 挂上运行时服务，接迁移好的测试库。

配置表现在仍有指向 ``iclip.users`` 的外键、建表也在后端的迁移里，所以这些用例放在后端的集成层；
``X-End-User`` 用的是种进库里的真实用户。插件登记表默认只有一个测试插件 ``limited``，模型按名字换成
集成层 ``models`` 夹具给的替身。

``ASGITransport`` 不跑 lifespan：要让消息真跑起来的用例另取 ``running``，它起停运行驱动。WebSocket 与回调
的用例取 ``live``：同步 ``TestClient`` 跑着 lifespan，另有一份不跨事件循环的 engine。
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncGenerator, Generator, Mapping
from pathlib import Path

import httpx
import pytest
from agent_runtime.http.app import create_app
from agent_runtime.plugins.base import PluginRegistry
from agent_runtime.settings import (
    AgentRunsSection,
    CompactionSection,
    ResolvedApp,
    ResolvedHooks,
    RuntimeSettings,
)
from fastapi import FastAPI
from pydantic_ai.models import Model
from sqlalchemy.ext.asyncio import AsyncEngine
from sqlalchemy.pool import NullPool
from starlette.testclient import TestClient

from iclip.platform.db.engine import build_engine
from tests.helpers.agents import model_builder
from tests.helpers.app import TEST_CREDENTIAL_KEY, TEST_MODEL_NAME
from tests.helpers.model_providers import GOOD_KEY, KeyCheckingProbe
from tests.helpers.pg import connected, reset_database
from tests.helpers.references import plant_user
from tests.helpers.runtime_service import (
    ADMIN_KEY,
    READER_KEY,
    ApprovingPlugin,
    HookRecorder,
    JottingPlugin,
    LimitedPlugin,
    LiveRuntime,
    add_model,
    connect_provider,
    publish_agent,
)


@pytest.fixture
def plugin_registry() -> PluginRegistry:
    """测试可覆写：交给运行时服务的插件登记表。"""

    return {"limited": LimitedPlugin}


def _settings(
    database_url: str, tmp_path: Path, *, reader_hooks: ResolvedHooks | None
) -> RuntimeSettings:
    """两个应用：有管理权限的 ``bff`` 与被测的 ``reader``（回调只配在它上面）。"""

    return RuntimeSettings(
        database_url=database_url,
        credential_encryption_keys=(TEST_CREDENTIAL_KEY,),
        apps=(
            ResolvedApp(id="bff", key=ADMIN_KEY, admin=True),
            ResolvedApp(id="reader", key=READER_KEY, admin=False, hooks=reader_hooks),
        ),
        agent_runs=AgentRunsSection(skill_cache_dir=tmp_path / "skills"),
        compaction=CompactionSection(),
        log_level="WARNING",
        log_format="console",
    )


@pytest.fixture
def runtime_app(
    engine: AsyncEngine,
    migrated_pg: str,
    tmp_path: Path,
    plugin_registry: PluginRegistry,
    models: Mapping[str, Model],
) -> FastAPI:
    return create_app(
        _settings(migrated_pg, tmp_path, reader_hooks=None),
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


LIVE_AGENT = "director"
"""``live`` 发布好的 agent。"""


@pytest.fixture
def live_agent_plugins() -> tuple[str, ...]:
    """测试可覆写：``live`` 发布的 agent 挂哪些测试插件（``approving``、``jotting``）。"""

    return ()


@pytest.fixture
def reader_hooks() -> ResolvedHooks | None:
    """测试可覆写：被测应用 ``reader`` 的回调；默认没有。"""

    return None


@pytest.fixture
def hook_recorder() -> HookRecorder:
    return HookRecorder()


@pytest.fixture
def live(
    migrated_pg: str,
    tmp_path: Path,
    models: Mapping[str, Model],
    live_agent_plugins: tuple[str, ...],
    reader_hooks: ResolvedHooks | None,
    hook_recorder: HookRecorder,
) -> Generator[LiveRuntime]:
    """跑着 lifespan 的运行时服务，给同步 ``TestClient`` 用（WebSocket 只能这样测）。

    ``TestClient`` 有自己的事件循环：engine 用 NullPool，种用户、接供应商、发布 agent 都在进它之前的另一个
    事件循环里做完，不跨循环复用连接。回调经 ``hook_recorder`` 接住。"""

    asyncio.run(_reset(migrated_pg))
    engine = build_engine(migrated_pg, poolclass=NullPool)
    settings = _settings(migrated_pg, tmp_path, reader_hooks=reader_hooks)
    app = create_app(
        settings,
        plugins=lambda host: {
            "approving": ApprovingPlugin,
            "jotting": JottingPlugin.bind(files=host.files),
        },
        credential_probe=KeyCheckingProbe({GOOD_KEY}),
        engine=engine,
        build_model=model_builder(models),
        hook_transport=httpx.MockTransport(hook_recorder),
    )
    owner = asyncio.run(_seed_live(app, engine, live_agent_plugins))
    try:
        with TestClient(app) as tc:
            yield LiveRuntime(tc=tc, app=app, owner=owner, agent=LIVE_AGENT)
    finally:
        asyncio.run(engine.dispose())


async def _reset(url: str) -> None:
    async with connected(url) as conn:
        await reset_database(conn)


async def _seed_live(app: FastAPI, engine: AsyncEngine, plugins: tuple[str, ...]) -> uuid.UUID:
    actor = await plant_user(engine, "runtime-admin")
    owner = await plant_user(engine, "session-owner")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://runtime.test/v1/admin",
        headers={"Authorization": f"Bearer {ADMIN_KEY}", "X-End-User": str(actor)},
    ) as admin:
        provider_id = await connect_provider(admin)
        await add_model(admin, provider_id, TEST_MODEL_NAME)
        await publish_agent(admin, LIVE_AGENT, plugins=plugins)
    return owner


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
