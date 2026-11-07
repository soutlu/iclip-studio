from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncGenerator, Generator, Mapping
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI
from pydantic_ai.models import Model
from pydantic_ai.models.test import TestModel
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine
from sqlalchemy.pool import NullPool
from starlette.testclient import TestClient

from agent_runtime.http.app import create_app
from agent_runtime.plugins.base import PluginRegistry
from agent_runtime.settings import (
    AgentRunsSection,
    CompactionSection,
    ResolvedApp,
    ResolvedHooks,
    RuntimeSettings,
)
from tests.helpers.model_providers import GOOD_KEY, KeyCheckingProbe
from tests.helpers.pg import reset_database
from tests.helpers.runtime_service import (
    ADMIN_KEY,
    READER_KEY,
    TEST_CREDENTIAL_KEY,
    TEST_MODEL_NAME,
    ApprovingPlugin,
    HookRecorder,
    JottingPlugin,
    LimitedPlugin,
    LiveRuntime,
    add_model,
    connect_provider,
    model_builder,
    publish_agent,
)


@pytest.fixture
def models() -> Mapping[str, Model]:
    return {TEST_MODEL_NAME: TestModel()}


@pytest.fixture
def plugin_registry() -> PluginRegistry:
    return {"limited": LimitedPlugin}


def _settings(
    database_url: str, tmp_path: Path, *, reader_hooks: ResolvedHooks | None
) -> RuntimeSettings:
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
    async with runtime_app.router.lifespan_context(runtime_app):
        yield


@pytest.fixture
def actor() -> uuid.UUID:
    return uuid.uuid4()


@pytest.fixture
def owner() -> uuid.UUID:
    return uuid.uuid4()


LIVE_AGENT = "director"


@pytest.fixture
def live_agent_plugins() -> tuple[str, ...]:
    return ()


@pytest.fixture
def reader_hooks() -> ResolvedHooks | None:
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
    asyncio.run(reset_database(migrated_pg))
    engine = create_async_engine(migrated_pg, pool_pre_ping=True, poolclass=NullPool)
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
    owner = asyncio.run(_seed_live(app, live_agent_plugins))
    try:
        with TestClient(app) as tc:
            yield LiveRuntime(tc=tc, app=app, owner=owner, agent=LIVE_AGENT)
    finally:
        asyncio.run(engine.dispose())


async def _seed_live(app: FastAPI, plugins: tuple[str, ...]) -> uuid.UUID:
    actor, owner = uuid.uuid4(), uuid.uuid4()
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
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=runtime_app), base_url="http://runtime.test"
    ) as client:
        yield client


@pytest.fixture
async def admin(runtime_app: FastAPI, actor: uuid.UUID) -> AsyncGenerator[httpx.AsyncClient]:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=runtime_app),
        base_url="http://runtime.test/v1/admin",
        headers={"Authorization": f"Bearer {ADMIN_KEY}", "X-End-User": str(actor)},
    ) as client:
        yield client


@pytest.fixture
async def app_client(runtime_app: FastAPI, owner: uuid.UUID) -> AsyncGenerator[httpx.AsyncClient]:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=runtime_app),
        base_url="http://runtime.test/v1",
        headers={"Authorization": f"Bearer {READER_KEY}", "X-End-User": str(owner)},
    ) as client:
        yield client
