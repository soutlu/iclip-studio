from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncGenerator, Generator, Mapping
from pathlib import Path

import httpx
import pytest
from agent_runtime.migrations.runner import upgrade as upgrade_runtime
from agent_runtime.plugins.base import PluginBinder, PluginRegistry
from alembic import command
from alembic.config import Config as AlembicConfig
from fastapi import FastAPI
from pydantic_ai import models as pydantic_ai_models
from pydantic_ai.models import Model
from pydantic_ai.models.test import TestModel
from sqlalchemy.ext.asyncio import AsyncEngine
from sqlalchemy.pool import NullPool

from iclip.config import RuntimeConfig, SsoSection
from iclip.domains.identity.pms import PmsUserClient
from iclip.domains.identity.sso import SsoVerifier
from iclip.platform.db.engine import build_engine
from tests.helpers.agents import AgentSeed, model_builder, seed_agents
from tests.helpers.app import (
    TEST_CREDENTIAL_KEY,
    TEST_MODEL_NAME,
    make_client,
    make_runtime_config,
)
from tests.helpers.media_probe import offline_media_checks
from tests.helpers.model_providers import GOOD_KEY, KeyCheckingProbe
from tests.helpers.pg import connected, reset_database
from tests.helpers.runtime_backed import (
    RUNTIME_APP_KEY,
    RUNTIME_INTERNAL_TOKEN,
    build_backed_app,
    config_services_of,
    standard_plugins,
)

SERVER_DIR = Path(__file__).resolve().parents[2]


@pytest.fixture(autouse=True)
def _no_real_model_requests(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(pydantic_ai_models, "ALLOW_MODEL_REQUESTS", False)


@pytest.fixture(autouse=True)
def _offline_media_checks(monkeypatch: pytest.MonkeyPatch) -> None:
    offline_media_checks(monkeypatch)


TEST_SECRET = "test-secret-0123456789-0123456789-xyz"


@pytest.fixture(scope="session")
def pg_url() -> Generator[str]:
    explicit = os.environ.get("TEST_DATABASE_URL", "").strip()
    if explicit:
        yield explicit
        return
    try:
        from testcontainers.community.postgres import PostgresContainer
    except ImportError:
        pytest.skip("无 TEST_DATABASE_URL 且未安装 testcontainers")
    try:
        container = PostgresContainer("postgres:16", driver="asyncpg")
        container.start()
    except Exception as exc:
        pytest.skip(f"本地无可用 Docker/Postgres: {exc}")
    try:
        yield container.get_connection_url()
    finally:
        container.stop()


@pytest.fixture(scope="session")
def migrated_pg(pg_url: str) -> str:
    cfg = AlembicConfig(str(SERVER_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(SERVER_DIR / "migrations"))
    cfg.attributes["sqlalchemy_url"] = pg_url
    command.upgrade(cfg, "head")
    upgrade_runtime(pg_url)
    return pg_url


@pytest.fixture
def base_env(monkeypatch: pytest.MonkeyPatch, migrated_pg: str) -> None:
    monkeypatch.setenv("DATABASE_URL", migrated_pg)
    monkeypatch.setenv("AUTH_SECRET", TEST_SECRET)
    monkeypatch.setenv("CREDENTIAL_ENCRYPTION_KEYS", TEST_CREDENTIAL_KEY)
    monkeypatch.setenv("RUNTIME_APP_KEY", RUNTIME_APP_KEY)
    monkeypatch.setenv("RUNTIME_INTERNAL_TOKEN", RUNTIME_INTERNAL_TOKEN)
    monkeypatch.delenv("PRODUCT_CATALOG_DATABASE_URL", raising=False)


async def _reset(url: str) -> None:
    async with connected(url) as conn:
        await reset_database(conn)


@pytest.fixture
async def engine(migrated_pg: str) -> AsyncGenerator[AsyncEngine]:
    await _reset(migrated_pg)
    engine = build_engine(migrated_pg)
    try:
        yield engine
    finally:
        await engine.dispose()


@pytest.fixture
def agent_seeds() -> tuple[AgentSeed, ...]:
    return ()


@pytest.fixture
def models() -> Mapping[str, Model]:
    return {TEST_MODEL_NAME: TestModel()}


@pytest.fixture
def runtime_plugins() -> PluginRegistry | PluginBinder:
    return standard_plugins


def _build_app(
    config: RuntimeConfig,
    engine: AsyncEngine,
    models: Mapping[str, Model],
    plugins: PluginRegistry | PluginBinder,
    skill_cache_dir: Path,
) -> FastAPI:
    return build_backed_app(
        config,
        engine=engine,
        build_model=model_builder(models),
        credential_probe=KeyCheckingProbe({GOOD_KEY}),
        plugins=plugins,
        skill_cache_dir=skill_cache_dir,
    )


@pytest.fixture
def cors_allow_origins() -> tuple[str, ...]:
    return ()


@pytest.fixture
def cookie_secure() -> bool:
    return False


@pytest.fixture
def preview_origin() -> str | None:
    return None


@pytest.fixture
async def app(
    base_env: None,
    engine: AsyncEngine,
    agent_seeds: tuple[AgentSeed, ...],
    models: Mapping[str, Model],
    runtime_plugins: PluginRegistry | PluginBinder,
    cors_allow_origins: tuple[str, ...],
    cookie_secure: bool,
    preview_origin: str | None,
    tmp_path: Path,
) -> FastAPI:
    built = _build_app(
        make_runtime_config(
            cors_allow_origins=cors_allow_origins,
            cookie_secure=cookie_secure,
            preview_origin=preview_origin,
        ),
        engine,
        models,
        runtime_plugins,
        tmp_path / "skills",
    )
    if agent_seeds:
        await seed_agents(config_services_of(built), engine, agent_seeds)
    return built


@pytest.fixture
def ws_agent_app(
    base_env: None,
    migrated_pg: str,
    agent_seeds: tuple[AgentSeed, ...],
    models: Mapping[str, Model],
    cors_allow_origins: tuple[str, ...],
    preview_origin: str | None,
    runtime_plugins: PluginRegistry | PluginBinder,
    tmp_path: Path,
) -> Generator[FastAPI]:
    asyncio.run(_reset(migrated_pg))
    engine = build_engine(migrated_pg, poolclass=NullPool)
    built = _build_app(
        make_runtime_config(cors_allow_origins=cors_allow_origins, preview_origin=preview_origin),
        engine,
        models,
        runtime_plugins,
        tmp_path / "skills",
    )
    if agent_seeds:
        asyncio.run(seed_agents(config_services_of(built), engine, agent_seeds))
    yield built
    asyncio.run(engine.dispose())


@pytest.fixture
def root_email() -> str | None:
    return None


@pytest.fixture
def sso_oauth_name() -> str | None:
    return None


@pytest.fixture
async def sso_app(
    base_env: None,
    migrated_pg: str,
    sso_transport: httpx.MockTransport,
    pms_transport: httpx.MockTransport | None,
    root_email: str | None,
    sso_oauth_name: str | None,
) -> AsyncGenerator[FastAPI]:
    sso = SsoSection(
        app_name="iclip",
        base_url="https://sso.test",
        redirect_url="https://app.test/auth/sso/landing",
        pms_base_url="https://pms.test" if pms_transport is not None else None,
        root_email=root_email,
    )
    if sso_oauth_name:
        sso = sso.model_copy(update={"oauth_name": sso_oauth_name})
    verifier = SsoVerifier(
        base_url=sso.base_url,
        app_name=sso.app_name,
        redirect_url=sso.redirect_url,
        transport=sso_transport,
    )
    pms = (
        PmsUserClient(base_url=sso.pms_base_url, transport=pms_transport)
        if sso.pms_base_url is not None
        else None
    )
    await _reset(migrated_pg)
    engine = build_engine(migrated_pg)
    try:
        yield build_backed_app(
            make_runtime_config().model_copy(update={"sso": sso}),
            engine=engine,
            sso_verifier=verifier,
            pms_client=pms,
            credential_probe=KeyCheckingProbe({GOOD_KEY}),
        )
    finally:
        await engine.dispose()


@pytest.fixture
async def client(app: FastAPI) -> AsyncGenerator[httpx.AsyncClient]:
    async with make_client(app) as c:
        yield c
