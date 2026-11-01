"""运行时服务的 MCP 服务：请求头加密存、只给打码值、改的时候没给值就沿用；试连记下结果与发现的工具，没保存的
配置试连什么都不存；发布时查服务与选的工具；被 agent 挂着时不能停用、不能删；换钥连请求头一起换；运行时
agent 真去调本地 MCP 服务的工具，工具名带服务前缀、只放选了的工具，连不上时这次运行失败并写明是哪个服务。

MCP 服务是进程内的本地服务（``tests.helpers.mcp``），不出网。"""

from __future__ import annotations

import json
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest
from agent_runtime.config.mcp_servers.infra_sql import SqlMcpServerStore
from agent_runtime.config.mcp_servers.service import rotate_mcp_header_keys
from agent_runtime.secrets import CredentialCipher
from cryptography.fernet import Fernet
from pydantic_ai.messages import ModelMessage, ModelRequest, ToolReturnPart
from pydantic_ai.models import Model
from pydantic_ai.models.function import AgentInfo, DeltaToolCall, DeltaToolCalls, FunctionModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from tests.helpers.app import TEST_CREDENTIAL_KEY, TEST_MODEL_NAME
from tests.helpers.mcp import TOKEN, TOOLS, LocalMcp, free_port, local_mcp
from tests.helpers.runtime_service import PROVIDER, add_model, connect_provider, settled

AGENT = "director"
MASKED = "••••" + TOKEN[-4:]


@dataclass
class Script:
    """模型替身照着演：``call`` 是第一次请求时调的工具与参数，之后一律答「好了」。``offered`` 记下每次请求
    交给模型的工具名，``requests`` 记下每次请求的消息。"""

    call: tuple[str, dict[str, Any]] | None = None
    offered: list[list[str]] = field(default_factory=list[list[str]])
    requests: list[list[ModelMessage]] = field(default_factory=list[list[ModelMessage]])


@pytest.fixture
def script() -> Script:
    return Script()


@pytest.fixture
def models(script: Script) -> dict[str, Model]:
    async def stream(
        messages: list[ModelMessage], info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        script.offered.append(sorted(tool.name for tool in info.function_tools))
        script.requests.append(list(messages))
        if script.call is not None and len(messages) == 1:
            name, args = script.call
            yield {0: DeltaToolCall(name=name, json_args=json.dumps(args), tool_call_id="call_mcp")}
        else:
            yield "好了"

    return {TEST_MODEL_NAME: FunctionModel(stream_function=stream)}


@pytest.fixture
async def mcp() -> AsyncIterator[LocalMcp]:
    async with local_mcp() as server:
        yield server


def server_body(mcp: LocalMcp, **fields: Any) -> dict[str, Any]:
    return {
        "id": "calc",
        "name": "计算器",
        "url": mcp.http_url,
        "transport": "streamable_http",
        "timeoutSeconds": 5,
        "headers": [{"name": "Authorization", "value": TOKEN}],
        **fields,
    }


async def create_server(admin: httpx.AsyncClient, mcp: LocalMcp, **fields: Any) -> dict[str, Any]:
    created = await admin.post("/mcp-servers", json=server_body(mcp, **fields))
    assert created.status_code == 201, created.text
    assert TOKEN not in created.text
    return created.json()


async def check(admin: httpx.AsyncClient, server_id: str = "calc") -> dict[str, Any]:
    checked = await admin.post(f"/mcp-servers/{server_id}/check")
    assert checked.status_code == 200, checked.text
    assert TOKEN not in checked.text
    return checked.json()


async def read(admin: httpx.AsyncClient, server_id: str = "calc") -> dict[str, Any]:
    found = await admin.get(f"/mcp-servers/{server_id}")
    assert found.status_code == 200, found.text
    assert TOKEN not in found.text
    return found.json()


async def stored_headers(engine: AsyncEngine, server_id: str = "calc") -> list[dict[str, str]]:
    async with engine.connect() as conn:
        raw = (
            await conn.execute(
                text("SELECT headers FROM agent_runtime.mcp_servers WHERE id = :id"),
                {"id": server_id},
            )
        ).scalar_one()
    return raw if isinstance(raw, list) else json.loads(raw)


def plain(headers: list[dict[str, str]], cipher: CredentialCipher) -> dict[str, str]:
    return {one["name"]: cipher.decrypt(one["value"]) for one in headers}


def mcp_tool(server: str = "calc", tools: list[str] | None = None) -> dict[str, Any]:
    return {"type": "mcp", "server": server, "tools": tools}


async def save_draft(admin: httpx.AsyncClient, *tools: dict[str, Any]) -> int:
    """建好 ``AGENT``（已有就沿用），把草稿存成挂着这些工具的配置，交回新的 ``lockVersion``。"""

    detail = await admin.get(f"/agents/{AGENT}")
    if detail.status_code == 404:
        detail = await admin.post("/agents", json={"id": AGENT, "name": "导演"})
    assert detail.status_code in {200, 201}, detail.text
    saved = await admin.put(
        f"/agents/{AGENT}/draft",
        json={
            "config": {
                "schema_version": 1,
                "model": {"provider": PROVIDER, "name": TEST_MODEL_NAME},
                "tools": list(tools),
            },
            "skillIds": [],
            "lockVersion": detail.json()["draft"]["lockVersion"],
        },
    )
    assert saved.status_code == 200, saved.text
    return int(saved.json()["draft"]["lockVersion"])


async def publish(admin: httpx.AsyncClient, lock_version: int) -> httpx.Response:
    return await admin.post(f"/agents/{AGENT}/versions", json={"lockVersion": lock_version})


async def publish_listed(admin: httpx.AsyncClient, *tools: dict[str, Any]) -> None:
    published = await publish(admin, await save_draft(admin, *tools))
    assert published.status_code == 201, published.text
    listed = await admin.patch(f"/agents/{AGENT}", json={"listed": True})
    assert listed.status_code == 200, listed.text


@pytest.fixture
async def provider(admin: httpx.AsyncClient) -> None:
    provider_id = await connect_provider(admin)
    await add_model(admin, provider_id, TEST_MODEL_NAME)


async def open_and_prompt(app_client: httpx.AsyncClient) -> str:
    session = str(uuid.uuid4())
    opened = await app_client.post("/sessions", json={"id": session, "agent_id": AGENT})
    assert opened.status_code == 204, opened.text
    sent = await app_client.post(
        f"/sessions/{session}/prompts",
        json={
            "prompt_id": "prm_mcp",
            "content": [{"type": "text", "text": "算一下"}],
            "user_name": "logan",
            "agent_id": AGENT,
        },
    )
    assert sent.status_code == 200, sent.text
    await settled(app_client, session)
    return session


async def only_turn(app_client: httpx.AsyncClient, session: str) -> dict[str, Any]:
    page = await app_client.get(f"/sessions/{session}/transcript", params={"session_agent": AGENT})
    assert page.status_code == 200, page.text
    (turn,) = page.json()["items"]
    return turn


def tool_frames(turn: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        frame for step in turn["steps"] for frame in step["frames"] if frame.get("kind") == "tool"
    ]


# --- 管理接口 --------------------------------------------------------------------


async def test_headers_are_encrypted_masked_and_kept_when_omitted(
    admin: httpx.AsyncClient, engine: AsyncEngine, mcp: LocalMcp
) -> None:
    cipher = CredentialCipher([TEST_CREDENTIAL_KEY])
    created = await create_server(admin, mcp)

    assert created["headers"] == [{"name": "Authorization", "value": MASKED}]
    assert (created["lastCheck"], created["tools"], created["usedBy"]) == (None, None, [])
    (stored,) = await stored_headers(engine)
    assert stored["value"] != TOKEN
    assert cipher.decrypt(stored["value"]) == TOKEN

    kept = await admin.patch(
        "/mcp-servers/calc",
        json={"headers": [{"name": "authorization"}, {"name": "X-Tenant", "value": "acme-01"}]},
    )
    assert kept.status_code == 200, kept.text
    assert TOKEN not in kept.text
    assert [one["value"] for one in kept.json()["headers"]] == [MASKED, "••••"]
    assert plain(await stored_headers(engine), cipher) == {
        "authorization": TOKEN,
        "X-Tenant": "acme-01",
    }

    unknown = await admin.patch("/mcp-servers/calc", json={"headers": [{"name": "X-New"}]})
    assert unknown.status_code == 422
    assert "X-New" in unknown.json()["detail"]
    repeated = await admin.patch(
        "/mcp-servers/calc",
        json={"headers": [{"name": "A", "value": "1"}, {"name": "a", "value": "2"}]},
    )
    assert repeated.status_code == 422

    cleared = await admin.patch("/mcp-servers/calc", json={"headers": []})
    assert cleared.json()["headers"] == []
    assert await stored_headers(engine) == []


async def test_create_checks_the_fields(admin: httpx.AsyncClient, mcp: LocalMcp) -> None:
    for fields in (
        {"id": "Calc"},
        {"id": "calc_2"},
        {"url": "ftp://127.0.0.1/mcp"},
        {"transport": "stdio"},
        {"timeoutSeconds": 0},
        {"headers": [{"name": "Authorization"}]},
        {"headers": [{"name": "Bad Name", "value": "x"}]},
    ):
        refused = await admin.post("/mcp-servers", json=server_body(mcp, **fields))
        assert refused.status_code == 422, (fields, refused.text)
    await create_server(admin, mcp)
    taken = await admin.post("/mcp-servers", json=server_body(mcp))
    assert taken.status_code == 409


async def test_saved_check_records_the_result_and_the_discovered_tools(
    admin: httpx.AsyncClient, mcp: LocalMcp
) -> None:
    await create_server(admin, mcp)

    reached = await check(admin)
    assert reached["ok"] is True
    assert reached["reason"] is None
    assert reached["elapsedMs"] >= 0
    assert [tool["name"] for tool in reached["tools"]] == list(TOOLS)
    assert reached["tools"][0]["description"] == "Add two integers."
    saved = await read(admin)
    assert saved["lastCheck"]["ok"] is True
    assert [tool["name"] for tool in saved["tools"]] == list(TOOLS)

    # 请求头不对：这次试连没通，原因记下，发现的工具还是上次通的那份。
    wrong = await admin.patch(
        "/mcp-servers/calc", json={"headers": [{"name": "Authorization", "value": "Bearer nope"}]}
    )
    assert wrong.status_code == 200, wrong.text
    refused = await check(admin)
    assert (refused["ok"], refused["tools"]) == (False, None)
    assert refused["reason"]
    after = await read(admin)
    assert after["lastCheck"]["ok"] is False
    assert after["lastCheck"]["reason"] == refused["reason"]
    assert [tool["name"] for tool in after["tools"]] == list(TOOLS)

    # 换了地址与连接方式就是另一个服务：上次的试连与工具清掉，SSE 照样连得通。
    moved = await admin.patch(
        "/mcp-servers/calc",
        json={
            "url": mcp.sse_url,
            "transport": "sse",
            "headers": [{"name": "Authorization", "value": TOKEN}],
        },
    )
    assert moved.status_code == 200, moved.text
    assert (moved.json()["lastCheck"], moved.json()["tools"]) == (None, None)
    assert (await check(admin))["ok"] is True


async def test_unsaved_check_stores_nothing_and_can_reuse_saved_header_values(
    admin: httpx.AsyncClient, mcp: LocalMcp
) -> None:
    form = {k: v for k, v in server_body(mcp).items() if k not in {"id", "name"}}
    passed = await admin.post("/mcp-servers/check", json=form)
    assert passed.status_code == 200, passed.text
    assert passed.json()["ok"] is True
    assert [tool["name"] for tool in passed.json()["tools"]] == list(TOOLS)
    without_token = await admin.post("/mcp-servers/check", json={**form, "headers": []})
    assert without_token.json()["ok"] is False

    await create_server(admin, mcp)
    reused = await admin.post(
        "/mcp-servers/check",
        json={**form, "serverId": "calc", "headers": [{"name": "Authorization"}]},
    )
    assert reused.status_code == 200, reused.text
    assert reused.json()["ok"] is True
    assert (await read(admin))["lastCheck"] is None

    no_value = await admin.post("/mcp-servers/check", json={**form, "headers": [{"name": "A"}]})
    assert no_value.status_code == 422
    ghost = await admin.post("/mcp-servers/check", json={**form, "serverId": "ghost"})
    assert ghost.status_code == 404

    unreachable = await admin.post(
        "/mcp-servers/check",
        json={**form, "url": f"http://127.0.0.1:{free_port()}/mcp", "timeoutSeconds": 2},
    )
    assert unreachable.status_code == 200, unreachable.text
    assert unreachable.json()["ok"] is False
    assert unreachable.json()["reason"]


async def test_publish_checks_the_server_and_the_chosen_tools(
    admin: httpx.AsyncClient, mcp: LocalMcp, provider: None
) -> None:
    # 存草稿只查结构：服务还不存在也存得下。
    lock = await save_draft(admin, mcp_tool(tools=["add"]))
    missing = await publish(admin, lock)
    assert missing.status_code == 422
    assert [one["path"] for one in missing.json()["problems"]] == ["tools[0].server"]

    await create_server(admin, mcp)
    never_reached = await publish(admin, lock)
    assert never_reached.status_code == 422
    assert "测试连接" in never_reached.json()["problems"][0]["message"]

    await check(admin)
    lock = await save_draft(admin, mcp_tool(tools=["add", "sqrt"]))
    unknown_tool = await publish(admin, lock)
    assert unknown_tool.status_code == 422
    assert [one["path"] for one in unknown_tool.json()["problems"]] == ["tools[0].tools[1]"]

    lock = await save_draft(admin, mcp_tool(tools=["add"]))
    assert (await publish(admin, lock)).status_code == 201

    disabled = await admin.post(
        "/mcp-servers", json=server_body(mcp, id="spare", name="备用", enabled=False)
    )
    assert disabled.status_code == 201, disabled.text
    lock = await save_draft(admin, mcp_tool(tools=["add"]), mcp_tool("spare"))
    off = await publish(admin, lock)
    assert off.status_code == 422
    # 停用与没连通过两条都列出来，都指到第二项的 server。
    assert {one["path"] for one in off.json()["problems"]} == {"tools[1].server"}
    assert "已停用" in off.json()["problems"][0]["message"]


async def test_a_server_in_use_cannot_be_disabled_or_deleted(
    admin: httpx.AsyncClient, mcp: LocalMcp, provider: None
) -> None:
    await create_server(admin, mcp)
    await check(admin)
    await publish_listed(admin, mcp_tool(tools=["add"]))

    assert (await read(admin))["usedBy"] == [
        {"agentId": AGENT, "agentName": "导演", "inDraft": True, "inActiveVersion": True}
    ]
    disabled = await admin.patch("/mcp-servers/calc", json={"enabled": False})
    deleted = await admin.delete("/mcp-servers/calc")
    assert (disabled.status_code, deleted.status_code) == (409, 409)
    assert AGENT in deleted.json()["detail"]

    # 草稿里去掉了，当前版本还挂着：照样拦。
    await save_draft(admin)
    assert (await read(admin))["usedBy"][0]["inDraft"] is False
    assert (await admin.delete("/mcp-servers/calc")).status_code == 409

    await publish(admin, int((await admin.get(f"/agents/{AGENT}")).json()["draft"]["lockVersion"]))
    assert (await read(admin))["usedBy"] == []
    assert (await admin.patch("/mcp-servers/calc", json={"enabled": False})).status_code == 200
    assert (await admin.delete("/mcp-servers/calc")).status_code == 204
    assert (await admin.get("/mcp-servers/calc")).status_code == 404


async def test_rotation_reencrypts_the_header_values(
    admin: httpx.AsyncClient, engine: AsyncEngine, mcp: LocalMcp
) -> None:
    await create_server(admin, mcp)
    await create_server(admin, mcp, id="spare", headers=[])
    new_key = Fernet.generate_key().decode()

    rotated = await rotate_mcp_header_keys(
        SqlMcpServerStore(engine), cipher=CredentialCipher([new_key, TEST_CREDENTIAL_KEY])
    )

    assert rotated == 2
    (stored,) = await stored_headers(engine)
    assert CredentialCipher([new_key]).decrypt(stored["value"]) == TOKEN
    with pytest.raises(RuntimeError):
        CredentialCipher([TEST_CREDENTIAL_KEY]).decrypt(stored["value"])


async def test_importing_a_package_checks_the_mcp_servers_it_names(
    admin: httpx.AsyncClient, mcp: LocalMcp, provider: None
) -> None:
    await create_server(admin, mcp, enabled=False)
    package = {
        "format_version": "1.0.0",
        "entry": AGENT,
        "agents": {
            AGENT: {
                "name": "导演",
                "description": "",
                "listed": True,
                "config": {
                    "schema_version": 1,
                    "model": {"provider": PROVIDER, "name": TEST_MODEL_NAME},
                    "tools": [mcp_tool(tools=["add"]), mcp_tool("ghost")],
                },
                "skills": [],
            }
        },
    }

    checked = await admin.post(
        "/agents/import",
        params={"dryRun": "true"},
        files={"file": ("director.yaml", json.dumps(package).encode(), "application/yaml")},
    )

    assert checked.status_code == 200, checked.text
    (item,) = checked.json()["agents"]
    assert [one["path"] for one in item["problems"]] == ["config.tools[1].server"]
    assert [one["path"] for one in item["warnings"]] == ["config.tools[0].server"]


# --- 运行 ------------------------------------------------------------------------


async def test_the_agent_calls_a_chosen_mcp_tool(
    running: None,
    admin: httpx.AsyncClient,
    app_client: httpx.AsyncClient,
    mcp: LocalMcp,
    provider: None,
    script: Script,
) -> None:
    await create_server(admin, mcp)
    await check(admin)
    await publish_listed(admin, mcp_tool(tools=["add"]))
    script.call = ("mcp_calc_add", {"a": 2, "b": 3})

    session = await open_and_prompt(app_client)

    assert (await app_client.get(f"/sessions/{session}/status")).json() == {"status": "completed"}
    assert mcp.calls == [("add", {"a": 2, "b": 3})]
    # 只放选了的工具，名字带上服务的前缀。
    assert script.offered[0] == ["mcp_calc_add"]
    (returned,) = [
        part
        for message in script.requests[1]
        if isinstance(message, ModelRequest)
        for part in message.parts
        if isinstance(part, ToolReturnPart)
    ]
    assert returned.tool_name == "mcp_calc_add"
    assert "5" in str(returned.content)
    (card,) = tool_frames(await only_turn(app_client, session))
    assert (card["name"], card["state"]) == ("mcp_calc_add", "done")
    assert card["display"] == {"kind": "generic", "summary": "add", "detail": "calc"}


async def test_a_failing_mcp_tool_goes_back_to_the_model(
    running: None,
    admin: httpx.AsyncClient,
    app_client: httpx.AsyncClient,
    mcp: LocalMcp,
    provider: None,
    script: Script,
) -> None:
    await create_server(admin, mcp)
    await check(admin)
    await publish_listed(admin, mcp_tool())
    script.call = ("mcp_calc_divide", {"a": 1, "b": 0})

    session = await open_and_prompt(app_client)

    assert (await app_client.get(f"/sessions/{session}/status")).json() == {"status": "completed"}
    assert script.offered[0] == ["mcp_calc_add", "mcp_calc_divide", "mcp_calc_shout"]
    assert mcp.calls == [("divide", {"a": 1, "b": 0})]
    # 服务报的错照原生的做法作为这次调用的结果交回模型，这一轮照常跑完。
    (returned,) = [
        part
        for message in script.requests[1]
        if isinstance(message, ModelRequest)
        for part in message.parts
        if isinstance(part, ToolReturnPart)
    ]
    assert returned.tool_name == "mcp_calc_divide"
    assert "cannot divide by zero" in str(returned.content)


async def test_an_unreachable_server_fails_the_run_naming_it(
    running: None,
    admin: httpx.AsyncClient,
    app_client: httpx.AsyncClient,
    mcp: LocalMcp,
    provider: None,
    script: Script,
) -> None:
    await create_server(admin, mcp)
    await check(admin)
    await publish_listed(admin, mcp_tool(tools=["add"]))
    gone = await admin.patch(
        "/mcp-servers/calc", json={"url": f"http://127.0.0.1:{free_port()}/mcp"}
    )
    assert gone.status_code == 200, gone.text

    session = await open_and_prompt(app_client)

    assert (await app_client.get(f"/sessions/{session}/status")).json() == {"status": "failed"}
    assert script.offered == [], "连不上就不调模型"
    turn = await only_turn(app_client, session)
    assert turn["state"] == "failed"
    assert "MCP 服务 计算器（calc）连不上" in turn["error"]
    assert TOKEN not in json.dumps(turn, ensure_ascii=False)
