"""MCP 服务端点：只有 ``agent:manage``（root）能用，editor 一律 403；其余照原样转给运行时，答复是同一份
camelCase、请求头只给打码值。规则本身在运行时服务的测试里（``runtime_service/test_mcp_servers.py``）。"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest

from tests.helpers.auth import login_as_editor, register_and_login, set_roles_in_db
from tests.helpers.mcp import TOKEN, TOOLS, LocalMcp, local_mcp


@pytest.fixture
async def mcp() -> AsyncIterator[LocalMcp]:
    async with local_mcp() as server:
        yield server


def body(mcp: LocalMcp) -> dict[str, Any]:
    return {
        "id": "calc",
        "name": "计算器",
        "url": mcp.http_url,
        "transport": "streamable_http",
        "headers": [{"name": "Authorization", "value": TOKEN}],
    }


async def test_editor_is_forbidden_everywhere(
    client: httpx.AsyncClient, migrated_pg: str, mcp: LocalMcp
) -> None:
    await login_as_editor(client, migrated_pg)

    calls: tuple[tuple[str, str, dict[str, Any] | None], ...] = (
        ("GET", "/mcp-servers", None),
        ("POST", "/mcp-servers", body(mcp)),
        ("POST", "/mcp-servers/check", {"url": mcp.http_url, "transport": "streamable_http"}),
        ("GET", "/mcp-servers/calc", None),
        ("PATCH", "/mcp-servers/calc", {"name": "x"}),
        ("DELETE", "/mcp-servers/calc", None),
        ("POST", "/mcp-servers/calc/check", None),
    )
    for method, url, payload in calls:
        response = await client.request(method, url, json=payload)
        assert response.status_code == 403, (method, url, response.text)
    assert mcp.calls == []


async def test_root_manages_a_server_through_the_backend(
    client: httpx.AsyncClient, migrated_pg: str, mcp: LocalMcp
) -> None:
    await register_and_login(client, username="root", email="root@example.com")
    await set_roles_in_db(migrated_pg, "root@example.com", ["root"])

    created = await client.post("/mcp-servers", json=body(mcp))
    assert created.status_code == 201, created.text
    assert TOKEN not in created.text
    assert created.json()["headers"] == [{"name": "Authorization", "value": "••••" + TOKEN[-4:]}]
    assert created.json()["timeoutSeconds"] == 30

    unsaved = await client.post(
        "/mcp-servers/check",
        json={
            "serverId": "calc",
            "url": mcp.http_url,
            "transport": "streamable_http",
            "headers": [{"name": "Authorization"}],
        },
    )
    assert unsaved.status_code == 200, unsaved.text
    assert unsaved.json()["ok"] is True

    checked = await client.post("/mcp-servers/calc/check")
    assert checked.status_code == 200, checked.text
    assert [tool["name"] for tool in checked.json()["tools"]] == list(TOOLS)

    listed = await client.get("/mcp-servers")
    assert listed.status_code == 200, listed.text
    (only,) = listed.json()["items"]
    assert only["lastCheck"]["ok"] is True
    assert TOKEN not in listed.text

    renamed = await client.patch("/mcp-servers/calc", json={"name": "小算盘"})
    assert renamed.json()["name"] == "小算盘"
    assert (await client.delete("/mcp-servers/calc")).status_code == 204
    missing = await client.get("/mcp-servers/calc")
    assert missing.status_code == 404
    assert set(missing.json()) == {"detail"}
