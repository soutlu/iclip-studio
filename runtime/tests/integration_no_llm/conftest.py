from __future__ import annotations

import asyncio
import uuid
from collections.abc import Generator
from typing import Any

import pytest
from sqlalchemy import make_url, text
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool
from testcontainers.community.postgres import PostgresContainer


@pytest.fixture(scope="session")
def pg_url() -> Generator[str]:
    container: Any = PostgresContainer("postgres:16", driver="asyncpg")
    container.start()
    try:
        yield container.get_connection_url()
    finally:
        container.stop()


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
