"""运行时服务连不上：经它的端点一律答 503，后端的信封、一句固定的话，答复与日志里都没有应用密钥。"""

from __future__ import annotations

from collections.abc import AsyncGenerator

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncEngine
from structlog.testing import capture_logs

from iclip.app.bootstrap import build_app
from iclip.app.errors import RUNTIME_UNAVAILABLE_DETAIL
from tests.helpers.app import make_client, make_runtime_config
from tests.helpers.auth import login_as_editor, register_and_login, set_roles_in_db
from tests.helpers.runtime_backed import RUNTIME_APP_KEY


def refuse(request: httpx.Request) -> httpx.Response:
    raise httpx.ConnectError("连接被拒绝", request=request)


@pytest.fixture
async def unreachable(base_env: None, engine: AsyncEngine) -> AsyncGenerator[httpx.AsyncClient]:
    app: FastAPI = build_app(
        make_runtime_config(), engine=engine, runtime_transport=httpx.MockTransport(refuse)
    )
    async with make_client(app) as client:
        yield client


async def test_the_agent_directory_is_503_when_the_runtime_is_unreachable(
    unreachable: httpx.AsyncClient, migrated_pg: str
) -> None:
    await login_as_editor(unreachable, migrated_pg)

    with capture_logs() as logs:
        listed = await unreachable.get("/conversations/agents")
        created = await unreachable.post("/conversations", json={"agentId": "director"})

    for answered in (listed, created):
        assert answered.status_code == 503
        assert answered.json() == {"detail": RUNTIME_UNAVAILABLE_DETAIL}
        assert RUNTIME_APP_KEY not in answered.text
    unavailable = [entry for entry in logs if entry["event"] == "运行时服务答不上"]
    assert len(unavailable) == 2
    assert RUNTIME_APP_KEY not in repr(logs)


async def test_an_admin_relay_is_503_when_the_runtime_is_unreachable(
    unreachable: httpx.AsyncClient, migrated_pg: str
) -> None:
    await register_and_login(unreachable, username="root", email="root@example.com")
    await set_roles_in_db(migrated_pg, "root@example.com", ["root"])

    answered = await unreachable.get("/skills")

    assert answered.status_code == 503
    assert answered.json() == {"detail": RUNTIME_UNAVAILABLE_DETAIL}
    assert RUNTIME_APP_KEY not in answered.text
