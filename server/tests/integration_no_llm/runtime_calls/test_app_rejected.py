"""运行时不认后端的应用密钥：经它的端点一律答 503，不答 401（浏览器会当成登录失效把人登出）；日志记一条
提示检查配置的错误，答复与日志里都没有密钥。"""

from __future__ import annotations

from collections.abc import AsyncGenerator

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncEngine
from structlog.testing import capture_logs

from iclip.app.errors import RUNTIME_UNAVAILABLE_DETAIL
from tests.helpers.app import make_client, make_runtime_config
from tests.helpers.auth import login_as_editor, register_and_login, set_roles_in_db
from tests.helpers.runtime_backed import RUNTIME_APP_KEY, build_backed_app

WRONG_KEY = "runtime-wrong-app-key-0123456789-abcdef"
"""后端配的 ``RUNTIME_APP_KEY``；运行时给应用 ``video`` 配的仍是 ``RUNTIME_APP_KEY``，两边对不上。"""

REJECTED = "运行时拒绝了后端的应用密钥或权限，检查 RUNTIME_APP_KEY 与运行时 apps.video 配置"


@pytest.fixture
async def mismatched(
    base_env: None, engine: AsyncEngine, monkeypatch: pytest.MonkeyPatch
) -> AsyncGenerator[httpx.AsyncClient]:
    monkeypatch.setenv("RUNTIME_APP_KEY", WRONG_KEY)
    async with make_client(build_backed_app(make_runtime_config(), engine=engine)) as client:
        yield client


def assert_unavailable(answered: httpx.Response) -> None:
    assert answered.status_code == 503
    assert answered.json() == {"detail": RUNTIME_UNAVAILABLE_DETAIL}
    assert WRONG_KEY not in answered.text
    assert RUNTIME_APP_KEY not in answered.text


async def test_the_agent_directory_is_503_when_the_runtime_rejects_the_key(
    mismatched: httpx.AsyncClient, migrated_pg: str
) -> None:
    await login_as_editor(mismatched, migrated_pg)

    with capture_logs() as logs:
        listed = await mismatched.get("/conversations/agents")
        created = await mismatched.post("/conversations", json={"agentId": "director"})

    for answered in (listed, created):
        assert_unavailable(answered)
    rejected = [entry for entry in logs if entry["event"] == REJECTED]
    assert [(entry["log_level"], entry["status"]) for entry in rejected] == [("error", 401)] * 2
    assert not [entry for entry in logs if entry["event"] == "运行时服务答不上"]
    assert WRONG_KEY not in repr(logs)


async def test_an_admin_relay_is_503_when_the_runtime_rejects_the_key(
    mismatched: httpx.AsyncClient, migrated_pg: str
) -> None:
    await register_and_login(mismatched, username="root", email="root@example.com")
    await set_roles_in_db(migrated_pg, "root@example.com", ["root"])

    with capture_logs() as logs:
        answered = await mismatched.get("/skills")

    assert_unavailable(answered)
    assert [entry["status"] for entry in logs if entry["event"] == REJECTED] == [401]
    assert WRONG_KEY not in repr(logs)
