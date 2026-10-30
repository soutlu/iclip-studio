"""通过完整 HTTP 登录与工具调用验证每次运行的身份隔离。

Agent 注册表为共享对象，deps 必须逐次运行传入，不能在装配时绑定首个用户。
"""

from __future__ import annotations

import httpx
import pytest
from fastapi import FastAPI
from pydantic_ai import RunContext
from pydantic_ai.capabilities import Capability
from sqlalchemy import text

from iclip.domains.agents.public import AgentRunDeps
from tests.helpers.agents import AgentSeed
from tests.helpers.app import make_client, new_conversation, settled
from tests.helpers.auth import register_and_login, set_roles_in_db
from tests.helpers.pg import connected
from tests.helpers.plugins import FixedPlugin

AGENT_ID = "storyboard"


def identity_capability() -> tuple[Capability[AgentRunDeps], ...]:
    """提供返回运行依赖的工具，用于验证 RunContext[AgentRunDeps] 注入。"""

    def whoami(ctx: RunContext[AgentRunDeps]) -> str:
        """报出这次运行的属主。"""

        return str(ctx.deps.user_id)

    def which_conversation(ctx: RunContext[AgentRunDeps]) -> str:
        """报出这次运行所属的对话。"""

        return ctx.deps.conversation_id

    def on_behalf_of(ctx: RunContext[AgentRunDeps]) -> str:
        """报出这次运行替谁跑。"""

        return f"for:{ctx.deps.user_name}"

    return (
        Capability[AgentRunDeps](id="identity", tools=[whoami, which_conversation, on_behalf_of]),
    )


@pytest.fixture
def agent_seeds() -> tuple[AgentSeed, ...]:
    return (AgentSeed(AGENT_ID, plugins=("identity",)),)


@pytest.fixture(autouse=True)
def registered_plugin(monkeypatch: pytest.MonkeyPatch) -> None:
    """替换组合根的插件登记表构造函数，使声明可解析测试 identity 插件。"""

    from iclip.app import bootstrap
    from iclip.app.plugin_registry import PluginRegistry

    def only_identity(**_: object) -> PluginRegistry:
        return {"identity": FixedPlugin.bind(name="identity", capabilities=identity_capability())}

    monkeypatch.setattr(bootstrap, "build_plugin_registry", only_identity)


async def tools_said(
    client: httpx.AsyncClient,
    prompt_id: str,
    *,
    conversation_id: str | None = None,
    user_name: str | None = None,
) -> list[str]:
    """直接检查工具返回值，避免整份 transcript 的子串匹配产生误报。"""

    conversation_id = conversation_id or await new_conversation(client, AGENT_ID)
    body: dict[str, object] = {
        "prompt_id": prompt_id,
        "content": [{"type": "text", "text": "你是谁"}],
    }
    if user_name is not None:
        body["user_name"] = user_name
    sent = await client.post(f"/conversations/{conversation_id}/prompts", json=body)
    assert sent.status_code == 200, sent.text
    await settled(client, conversation_id)
    page = (await client.get(f"/conversations/{conversation_id}/transcript")).json()
    return [
        str(frame["output"])
        for turn in page["items"]
        for step in turn["steps"]
        for frame in step["frames"]
        if frame["kind"] == "tool" and frame.get("output") is not None
    ]


def said_by(reported: list[str], *, among: set[str]) -> list[str]:

    return [value for value in reported if value in among]


async def test_tool_receives_the_caller_as_the_run_owner(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    alpha = await register_and_login(client, username="caller-alpha", email="alpha@example.com")
    await set_roles_in_db(pg_url, "alpha@example.com", ["editor"])

    conversation_id = await new_conversation(client, AGENT_ID)

    reported = await tools_said(client, "prm-whoami", conversation_id=conversation_id)
    assert alpha in reported
    assert conversation_id in reported


async def test_each_run_carries_its_own_owner(
    app: FastAPI, client: httpx.AsyncClient, pg_url: str
) -> None:

    alpha = await register_and_login(client, username="caller-alpha", email="alpha@example.com")
    await set_roles_in_db(pg_url, "alpha@example.com", ["editor"])
    mine = await tools_said(client, "prm-mine")

    async with make_client(app) as other:
        beta = await register_and_login(other, username="caller-beta", email="beta@example.com")
        await set_roles_in_db(pg_url, "beta@example.com", ["editor"])
        theirs = await tools_said(other, "prm-theirs")

    owners = {alpha, beta}
    assert said_by(mine, among=owners) == [alpha]
    assert said_by(theirs, among=owners) == [beta]


async def test_a_run_whose_owner_was_deactivated_fails_at_start(
    app: FastAPI, client: httpx.AsyncClient, pg_url: str
) -> None:
    """开跑闸门：属主账号已停用，消息照常受理，运行开跑即失败，工具一个都不跑。

    停用的账号登不进来，所以用替人办事的钥匙替他开对话、发消息；属主不存在的情形有外键挡着，造不出来。
    """

    await register_and_login(client, username="service-bot", email="bot@example.com")
    await set_roles_in_db(pg_url, "bot@example.com", ["root"])
    issued = await client.post(
        "/api-keys",
        json={"name": "relay", "permissions": ["agent:run", "agent:read", "users:act_as"]},
    )
    assert issued.status_code == 201, issued.text

    async with make_client(app) as machine:
        machine.headers["Authorization"] = f"Bearer {issued.json()['apiKey']['token']}"
        opened = await machine.post(
            "/conversations", json={"agentId": AGENT_ID, "userName": "designer-zhang"}
        )
        assert opened.status_code == 201, opened.text
        conversation_id = str(opened.json()["conversation"]["id"])
        await deactivate_in_db(pg_url, "designer-zhang")

        sent = await machine.post(
            f"/conversations/{conversation_id}/prompts",
            json={
                "prompt_id": "prm-deactivated",
                "content": [{"type": "text", "text": "你是谁"}],
                "user_name": "designer-zhang",
            },
        )
        assert sent.status_code == 200, sent.text
        await settled(machine, conversation_id)
        page = (await machine.get(f"/conversations/{conversation_id}/transcript")).json()

    assert await run_status(pg_url, conversation_id) == "failed"
    assert [
        frame
        for turn in page["items"]
        for step in turn["steps"]
        for frame in step["frames"]
        if frame["kind"] == "tool"
    ] == []


async def deactivate_in_db(pg_url: str, username: str) -> None:
    async with connected(pg_url) as conn:
        await conn.execute(
            text("UPDATE iclip.users SET is_active = false WHERE username = :username"),
            {"username": username},
        )


async def run_status(pg_url: str, conversation_id: str) -> str:
    """这段对话唯一一条消息的终态。"""

    async with connected(pg_url) as conn:
        row = await conn.execute(
            text(
                "SELECT status FROM agent_runtime.agent_jobs"
                " WHERE conversation_id = :conversation_id"
            ),
            {"conversation_id": conversation_id},
        )
        return str(row.scalar_one())


async def test_browser_run_is_on_behalf_of_the_login_user(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    """浏览器发消息不带 user_name，运行替登录的这个人跑。"""

    await register_and_login(client, username="caller-alpha", email="alpha@example.com")
    await set_roles_in_db(pg_url, "alpha@example.com", ["editor"])

    assert "for:caller-alpha" in await tools_said(client, "prm-behalf-browser")


async def test_api_key_run_is_on_behalf_of_the_named_user_not_the_key_owner(
    app: FastAPI, client: httpx.AsyncClient, pg_url: str
) -> None:
    """机器调用方替它的终端用户发消息：运行带的是它给的名字，不是 key 属主账号。"""

    await register_and_login(client, username="service-bot", email="bot@example.com")
    await set_roles_in_db(pg_url, "bot@example.com", ["root"])
    issued = await client.post(
        "/api-keys", json={"name": "relay", "permissions": ["agent:run", "agent:read"]}
    )
    assert issued.status_code == 201, issued.text

    async with make_client(app) as machine:
        machine.headers["Authorization"] = f"Bearer {issued.json()['apiKey']['token']}"
        reported = await tools_said(machine, "prm-behalf-key", user_name="designer-zhang")

    assert "for:designer-zhang" in reported
    assert "for:service-bot" not in reported
