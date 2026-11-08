from __future__ import annotations

from collections.abc import AsyncGenerator

import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.platform.db.engine import build_engine
from tests.helpers.app import make_runtime_config
from tests.helpers.pdm import recreate_pdm_styles
from tests.helpers.pg import reset_database
from tests.helpers.runtime_backed import build_backed_app


@pytest.fixture
async def catalog_engine(migrated_pg: str) -> AsyncGenerator[AsyncEngine]:
    engine = build_engine(migrated_pg)
    try:
        await recreate_pdm_styles(engine)
        yield engine
    finally:
        await engine.dispose()


@pytest.fixture
async def business_engine(migrated_pg: str) -> AsyncGenerator[AsyncEngine]:
    engine = build_engine(migrated_pg)
    try:
        async with engine.begin() as conn:
            await reset_database(conn)
        yield engine
    finally:
        await engine.dispose()


@pytest.fixture
async def app(
    monkeypatch: pytest.MonkeyPatch,
    base_env: None,
    migrated_pg: str,
    business_engine: AsyncEngine,
    catalog_engine: AsyncEngine,
) -> AsyncGenerator[FastAPI]:
    monkeypatch.setenv("PRODUCT_CATALOG_DATABASE_URL", migrated_pg)
    yield build_backed_app(
        make_runtime_config(),
        engine=business_engine,
        product_catalog_engine=catalog_engine,
    )


@pytest.fixture
async def app_without_catalog(
    base_env: None, business_engine: AsyncEngine
) -> AsyncGenerator[FastAPI]:
    yield build_backed_app(make_runtime_config(), engine=business_engine)
