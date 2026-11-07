from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncGenerator, Generator
from typing import Any

import httpx
import pytest
from pydantic_ai import models as pydantic_ai_models
from sqlalchemy import make_url, text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine
from sqlalchemy.pool import NullPool
from testcontainers.community.postgres import PostgresContainer

from agent_runtime.migrations.runner import upgrade
from tests.helpers.pg import reset_database


@pytest.fixture(autouse=True)
def _no_real_model_requests(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(pydantic_ai_models, "ALLOW_MODEL_REQUESTS", False)


@pytest.fixture(autouse=True)
def _offline_media_checks(monkeypatch: pytest.MonkeyPatch) -> None:
    def build(**_: object) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            transport=httpx.MockTransport(lambda _request: httpx.Response(200))
        )

    monkeypatch.setattr("agent_runtime.harness.media_check.public_client", build)


@pytest.fixture(scope="session")
def pg_url() -> Generator[str]:
    container: Any = PostgresContainer("postgres:16", driver="asyncpg")
    container.start()
    try:
        yield container.get_connection_url()
    finally:
        container.stop()


@pytest.fixture(scope="session")
def migrated_pg(pg_url: str) -> str:
    upgrade(pg_url)
    return pg_url


@pytest.fixture
async def engine(migrated_pg: str) -> AsyncGenerator[AsyncEngine]:
    await reset_database(migrated_pg)
    engine = create_async_engine(migrated_pg, pool_pre_ping=True)
    try:
        yield engine
    finally:
        await engine.dispose()


async def _run_admin(url: str, statement: str) -> None:
    engine = create_async_engine(url, poolclass=NullPool, isolation_level="AUTOCOMMIT")
    try:
        async with engine.connect() as conn:
            await conn.execute(text(statement))
    finally:
        await engine.dispose()


@pytest.fixture
def scratch_db(pg_url: str) -> Generator[str]:
    name = f"migration_{uuid.uuid4().hex[:12]}"
    asyncio.run(_run_admin(pg_url, f'CREATE DATABASE "{name}"'))
    try:
        yield make_url(pg_url).set(database=name).render_as_string(hide_password=False)
    finally:
        asyncio.run(_run_admin(pg_url, f'DROP DATABASE "{name}" WITH (FORCE)'))
