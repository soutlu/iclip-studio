"""迁移测试的夹具：从历史版本升级使用一次性库，不动会话共用的测试库。"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Generator

import pytest
from sqlalchemy import make_url

from tests.helpers.migrations import run_admin


@pytest.fixture
def scratch_db(pg_url: str) -> Generator[str]:
    """同一台 Postgres 上的一个一次性库，用完删掉。"""

    name = f"migration_{uuid.uuid4().hex[:12]}"
    asyncio.run(run_admin(pg_url, f'CREATE DATABASE "{name}"'))
    try:
        yield make_url(pg_url).set(database=name).render_as_string(hide_password=False)
    finally:
        asyncio.run(run_admin(pg_url, f'DROP DATABASE "{name}" WITH (FORCE)'))
