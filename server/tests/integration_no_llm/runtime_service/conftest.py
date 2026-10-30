"""运行时服务的夹具：经 ``httpx.ASGITransport`` 挂上运行时服务，接迁移好的测试库。

配置表现在仍有指向 ``iclip.users`` 的外键、建表也在后端的迁移里，所以这些用例放在后端的集成层；
``X-End-User`` 用的是种进库里的真实用户。插件登记表只有一个测试插件 ``limited``。
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator
from pathlib import Path

import httpx
import pytest
from agent_runtime.http import create_app
from agent_runtime.settings import (
    AgentRunsSection,
    CompactionSection,
    ResolvedApp,
    RuntimeSettings,
)
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncEngine

from tests.helpers.app import TEST_CREDENTIAL_KEY
from tests.helpers.model_providers import GOOD_KEY, KeyCheckingProbe
from tests.helpers.references import plant_user
from tests.helpers.runtime_service import ADMIN_KEY, READER_KEY, LimitedPlugin


@pytest.fixture
def runtime_app(engine: AsyncEngine, migrated_pg: str, tmp_path: Path) -> FastAPI:
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
        plugins={"limited": LimitedPlugin},
        credential_probe=KeyCheckingProbe({GOOD_KEY}),
        engine=engine,
    )


@pytest.fixture
async def actor(engine: AsyncEngine) -> uuid.UUID:
    """代办用户：库里的一个真实账号，作者列有外键指向它。"""

    return await plant_user(engine, "runtime-admin")


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
