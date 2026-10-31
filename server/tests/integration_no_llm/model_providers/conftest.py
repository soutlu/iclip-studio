"""模型供应商的集成夹具：试连换成只认几把 API Key 的替身，不发真实请求。"""

from __future__ import annotations

from collections.abc import AsyncGenerator

import pytest
from fastapi import FastAPI

from iclip.platform.db.engine import build_engine
from tests.helpers.app import make_runtime_config
from tests.helpers.model_providers import GOOD_KEY, OTHER_KEY, KeyCheckingProbe
from tests.helpers.pg import connected, reset_database
from tests.helpers.runtime_backed import build_backed_app


@pytest.fixture
def probe() -> KeyCheckingProbe:
    return KeyCheckingProbe({GOOD_KEY, OTHER_KEY})


@pytest.fixture
async def app(base_env: None, migrated_pg: str, probe: KeyCheckingProbe) -> AsyncGenerator[FastAPI]:
    async with connected(migrated_pg) as conn:
        await reset_database(conn)
    engine = build_engine(migrated_pg)
    try:
        yield build_backed_app(make_runtime_config(), engine=engine, credential_probe=probe)
    finally:
        await engine.dispose()
