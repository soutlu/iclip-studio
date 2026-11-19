from __future__ import annotations

import asyncio
from typing import Any

import httpx
import pytest
from agent_runtime.plugins.base import PluginRegistry
from fastapi import FastAPI
from pydantic_ai.capabilities import Capability
from pydantic_ai.tools import Tool
from sqlalchemy import text

from iclip.platform.db.engine import build_engine
from tests.helpers.agents import CONVERSABLE_SEEDS, SEEDER, AgentSeed, seed_agents
from tests.helpers.app import make_client, settled
from tests.helpers.auth import register_and_login, set_roles_in_db
from tests.helpers.pg import connected
from tests.helpers.plugins import FixedPlugin
from tests.helpers.runtime_backed import config_services_of
from tests.helpers.tasks import INPUTS


@pytest.fixture
def agent_seeds() -> tuple[AgentSeed, ...]:
    return CONVERSABLE_SEEDS


def people(listing: dict[str, Any]) -> list[str]:
    return [user["username"] for user in listing["items"] if user["username"] != SEEDER]


ACT_AS_GRANTS = ["agent:run", "agent:read", "tasks:read", "tasks:write", "users:act_as"]
PLAIN_GRANTS = ["agent:run", "agent:read", "tasks:read", "tasks:write"]


async def issue_key(
    root: httpx.AsyncClient, pg_url: str, permissions: list[str]
) -> tuple[str, str]:
    logan_id = await register_and_login(root)
    await set_roles_in_db(pg_url, "logan@example.com", ["root"])
    created = await root.post("/api-keys", json={"name": "partner-app", "permissions": permissions})
    assert created.status_code == 201, created.text
    return logan_id, created.json()["apiKey"]["token"]


def machine(app: FastAPI, token: str) -> httpx.AsyncClient:
    client = make_client(app)
    client.headers["Authorization"] = f"Bearer {token}"
    return client


async def test_act_as_key_files_task_and_conversation_under_the_named_person(
    app: FastAPI, migrated_pg: str
) -> None:
    async with make_client(app) as root:
        logan_id, token = await issue_key(root, migrated_pg, ACT_AS_GRANTS)
        async with machine(app, token) as gateway:
            task = await gateway.post(
                "/tasks",
                json={
                    "title": "替 Sara.Hong 提的",
                    "inputs": INPUTS,
                    "status": "published",
                    "userName": "Sara.Hong",
                },
            )
            assert task.status_code == 201, task.text
            task_id = task.json()["task"]["id"]
            creator = task.json()["task"]["creatorUserId"]
            assert creator != logan_id

            opened = await gateway.post(
                "/conversations",
                json={"agentId": "storyboard", "taskId": task_id, "userName": "Sara.Hong"},
            )
            assert opened.status_code == 201, opened.text
            conversation_id = opened.json()["conversation"]["id"]

            after = (await gateway.get(f"/tasks/{task_id}")).json()["task"]
            assert after["status"] == "confirmed"
            assert after["assigneeUserIds"] == [creator]

            files = await gateway.get(f"/conversations/{conversation_id}/workspace/files")
            assert files.status_code == 200, files.text

        users = (await root.get("/users")).json()["items"]
        placeholder = next(user for user in users if user["username"] == "Sara.Hong")
        assert placeholder["id"] == creator
        assert placeholder["roles"] == []
        assert (await root.get("/conversations/search")).json()["items"] == []


async def test_key_without_act_as_keeps_records_under_the_key_owner(
    app: FastAPI, migrated_pg: str
) -> None:
    async with make_client(app) as root:
        _, token = await issue_key(root, migrated_pg, PLAIN_GRANTS)
        async with machine(app, token) as gateway:
            opened = await gateway.post(
                "/conversations", json={"agentId": "storyboard", "userName": "Sara.Hong"}
            )
            assert opened.status_code == 201, opened.text

        assert len((await root.get("/conversations/search")).json()["items"]) == 1
        assert people((await root.get("/users")).json()) == ["logan"]


@pytest.mark.parametrize("registered", [False, True], ids=["placeholder", "registered"])
async def test_act_as_key_can_prompt_the_conversation_it_opened_for_someone(
    app: FastAPI, migrated_pg: str, registered: bool
) -> None:
    async with make_client(app) as root:
        _, token = await issue_key(root, migrated_pg, ACT_AS_GRANTS)
        person_id: str | None = None
        if registered:
            async with make_client(app) as person:
                person_id = await register_and_login(
                    person, username="Sara.Hong", email="sara.hong@example.com"
                )
        async with machine(app, token) as gateway:
            opened = await gateway.post(
                "/conversations", json={"agentId": "storyboard", "userName": "Sara.Hong"}
            )
            conversation_id = opened.json()["conversation"]["id"]
            sent = await gateway.post(
                f"/conversations/{conversation_id}/prompts",
                json={
                    "prompt_id": "prm_act_as_1",
                    "content": [{"type": "text", "text": "你是谁"}],
                    "user_name": "Sara.Hong",
                },
            )
            assert sent.status_code == 200, sent.text
            await settled(gateway, conversation_id)

        owner = await job_owner(migrated_pg, conversation_id)
        listing = (await root.get("/users")).json()
        assert owner == next(
            user["id"] for user in listing["items"] if user["username"] == "Sara.Hong"
        )
        if person_id is not None:
            assert owner == person_id
        assert sorted(people(listing)) == ["Sara.Hong", "logan"], (
            "钥匙属主加 Sara.Hong 一个账号，不多建占位"
        )


async def test_act_as_key_writes_a_workspace_file_only_as_the_conversation_owner(
    app: FastAPI, migrated_pg: str
) -> None:
    async with make_client(app) as root:
        _, token = await issue_key(root, migrated_pg, ACT_AS_GRANTS)
        async with machine(app, token) as gateway:
            opened = await gateway.post(
                "/conversations", json={"agentId": "storyboard", "userName": "Sara.Hong"}
            )
            conversation = opened.json()["conversation"]
            async with connected(migrated_pg) as conn:
                await conn.execute(
                    text(
                        "INSERT INTO agent_runtime.workspace_files "
                        "(namespace, path, content, version, created_at, updated_at) "
                        "VALUES (:ns, '提纲.md', '三幕', 1, now(), now())"
                    ),
                    {"ns": f"{conversation['ownerUserId']}/{conversation['id']}"},
                )
            url = f"/conversations/{conversation['id']}/workspace/file"
            edit = {"path": "提纲.md", "content": "四幕", "expectedVersion": 1}

            unnamed = await gateway.put(url, json=edit)
            assert unnamed.status_code == 403, "不报名字就是钥匙属主本人，不是这段对话的属主"
            stranger = await gateway.put(url, json={**edit, "userName": "Kim.Lee"})
            assert stranger.status_code == 403, "报的不是属主也写不进去"

            written = await gateway.put(url, json={**edit, "userName": "Sara.Hong"})
            assert written.status_code == 200, written.text
            assert written.json()["file"] == {"path": "提纲.md", "content": "四幕", "version": 2}


async def prompt_for_sara(gateway: httpx.AsyncClient) -> str:
    opened = await gateway.post(
        "/conversations", json={"agentId": "storyboard", "userName": "Sara.Hong"}
    )
    assert opened.status_code == 201, opened.text
    conversation_id = opened.json()["conversation"]["id"]
    sent = await gateway.post(
        f"/conversations/{conversation_id}/prompts",
        json={
            "prompt_id": "prm_act_as_1",
            "content": [{"type": "text", "text": "你是谁"}],
            "user_name": "Sara.Hong",
        },
    )
    assert sent.status_code == 200, sent.text
    return conversation_id


async def test_act_as_key_controls_the_run_only_as_the_conversation_owner(
    app: FastAPI, migrated_pg: str
) -> None:
    async with make_client(app) as root:
        _, token = await issue_key(root, migrated_pg, ACT_AS_GRANTS)
        async with machine(app, token) as gateway:
            conversation_id = await prompt_for_sara(gateway)
            await settled(gateway, conversation_id)
            base = f"/conversations/{conversation_id}"
            sara = {"user_name": "Sara.Hong"}
            steer = {"prompt_ids": ["prm_act_as_1"]}

            assert (await gateway.post(f"{base}:abort")).status_code == 404
            stranger = await gateway.post(f"{base}:abort", json={"user_name": "Kim.Lee"})
            assert stranger.status_code == 404, "报的不是属主也停不了"
            assert (await gateway.post(f"{base}:abort", json=sara)).status_code == 204

            # 报了属主才进到运行时：这条已经跑完，停不了也插不进去，是运行时答的 409
            prompt_abort = f"{base}/prompts/prm_act_as_1:abort"
            assert (await gateway.post(prompt_abort)).status_code == 404
            assert (await gateway.post(prompt_abort, json=sara)).status_code == 409
            assert (await gateway.post(f"{base}/prompts:steer", json=steer)).status_code == 404
            steered = await gateway.post(f"{base}/prompts:steer", json={**steer, **sara})
            assert steered.status_code == 409

            assert (await gateway.post(f"{base}/turns/t1:regenerate")).status_code == 404
            replayed = await gateway.post(f"{base}/turns/t1:regenerate", json=sara)
            assert replayed.status_code == 200, replayed.text
            await settled(gateway, conversation_id)


class TestActAsAnswersAnApproval:
    @pytest.fixture
    def agent_seeds(self) -> tuple[AgentSeed, ...]:
        return (AgentSeed("storyboard", plugins=("approval",)),)

    @pytest.fixture
    def runtime_plugins(self) -> PluginRegistry:
        def approved_action() -> str:
            return "已执行"

        capability = Capability[Any](
            id="approval", tools=[Tool(approved_action, requires_approval=True)]
        )
        return {"approval": FixedPlugin.bind(name="approval", capabilities=(capability,))}

    async def test_only_the_named_owner_can_answer_it(self, app: FastAPI, migrated_pg: str) -> None:
        async with make_client(app) as root:
            _, token = await issue_key(root, migrated_pg, ACT_AS_GRANTS)
            async with machine(app, token) as gateway:
                conversation_id = await prompt_for_sara(gateway)
                pending = await pending_interactions(gateway, conversation_id)
                url = f"/conversations/{conversation_id}/interactions/{pending[0]}"

                unnamed = await gateway.post(url, json={"approved": True})
                assert unnamed.status_code == 404
                answered = await gateway.post(
                    url, json={"approved": True, "user_name": "Sara.Hong"}
                )
                assert answered.status_code == 204, answered.text
                await settled(gateway, conversation_id)


async def pending_interactions(client: httpx.AsyncClient, conversation_id: str) -> list[str]:
    for _ in range(200):
        page = (await client.get(f"/conversations/{conversation_id}/transcript")).json()
        if page["pending_interactions"]:
            return page["pending_interactions"]
        await asyncio.sleep(0.02)
    raise AssertionError("一直没等到审批")


async def job_owner(pg_url: str, conversation_id: str) -> str:
    async with connected(pg_url) as conn:
        row = await conn.execute(
            text(
                "SELECT owner_user_id FROM agent_runtime.agent_jobs"
                " WHERE conversation_id = :conversation_id"
            ),
            {"conversation_id": conversation_id},
        )
        return str(row.scalar_one())


async def test_browser_session_may_only_name_itself(client: httpx.AsyncClient, pg_url: str) -> None:
    await register_and_login(client)
    await set_roles_in_db(pg_url, "logan@example.com", ["editor"])

    someone_else = await client.post(
        "/conversations", json={"agentId": "storyboard", "userName": "Sara.Hong"}
    )
    assert someone_else.status_code == 422
    myself = await client.post(
        "/conversations", json={"agentId": "storyboard", "userName": "logan"}
    )
    assert myself.status_code == 201, myself.text


@pytest.fixture
def pms_transport() -> httpx.MockTransport | None:
    return None


class TestSsoAdoptsThePlaceholder:
    @pytest.fixture
    def sso_transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(
            lambda request: httpx.Response(
                200,
                json={
                    "result": "OK",
                    "userSession": {
                        "innerUserId": 7,
                        "unionId": "u-7",
                        "name": "Sara.Hong",
                        "email": "sara.hong@corp.test",
                        "avatarUrl": "",
                    },
                },
            )
        )

    async def test_login_adopts_placeholder_and_its_records(
        self, sso_app: FastAPI, migrated_pg: str
    ) -> None:
        engine = build_engine(migrated_pg)
        try:
            await seed_agents(config_services_of(sso_app), engine, CONVERSABLE_SEEDS)
        finally:
            await engine.dispose()
        async with make_client(sso_app) as root:
            _, token = await issue_key(root, migrated_pg, ACT_AS_GRANTS)
            async with machine(sso_app, token) as gateway:
                opened = await gateway.post(
                    "/conversations",
                    json={"agentId": "storyboard", "title": "替他开的", "userName": "Sara.Hong"},
                )
                assert opened.status_code == 201, opened.text

        async with make_client(sso_app) as sara:
            callback = await sara.get("/auth/sso/callback", params={"jwt": "sso-jwt"})
            assert callback.status_code == 204, callback.text
            me = (await sara.get("/users/me")).json()["user"]
            assert me["username"] == "Sara.Hong"
            assert me["email"] == "sara.hong@corp.test"
            assert me["roles"] == ["viewer"]
            listed = (await sara.get("/conversations/search")).json()["items"]
        assert [item["title"] for item in listed] == ["替他开的"]

        async with make_client(sso_app) as root:
            login = await root.post(
                "/auth/login", data={"username": "logan", "password": "password-123"}
            )
            assert login.status_code == 204, login.text
            assert sorted(people((await root.get("/users")).json())) == ["Sara.Hong", "logan"]


class TestSsoLeavesASameNameRealAccountAlone:
    @pytest.fixture
    def sso_transport(self) -> httpx.MockTransport:
        sessions = {
            "jwt-a": {"innerUserId": 7, "unionId": "u-7", "name": "Sara.Hong", "email": None},
            "jwt-b": {
                "innerUserId": 8,
                "unionId": "u-8",
                "name": "Sara.Hong",
                "email": "b@corp.test",
            },
        }

        def verify(request: httpx.Request) -> httpx.Response:
            user_session = {**sessions[request.url.params["jwt"]], "avatarUrl": ""}
            return httpx.Response(200, json={"result": "OK", "userSession": user_session})

        return httpx.MockTransport(verify)

    async def test_same_name_newcomer_gets_an_account_of_their_own(
        self, sso_app: FastAPI, migrated_pg: str
    ) -> None:
        first = await sso_login(sso_app, "jwt-a")
        assert first["username"] == "Sara.Hong"
        assert first["email"] == "u-7@sso.iclip.example"

        newcomer = await sso_login(sso_app, "jwt-b")
        assert newcomer["email"] == "b@corp.test"
        assert newcomer["id"] != first["id"]

        again = await sso_login(sso_app, "jwt-a")
        assert again["id"] == first["id"]
        assert again["email"] == "u-7@sso.iclip.example"

        async with make_client(sso_app) as root:
            await register_and_login(root)
            await set_roles_in_db(migrated_pg, "logan@example.com", ["root"])
            assert (await root.get("/users")).json()["total"] == 3


async def sso_login(app: FastAPI, jwt: str) -> dict[str, Any]:
    async with make_client(app) as client:
        callback = await client.get("/auth/sso/callback", params={"jwt": jwt})
        assert callback.status_code == 204, callback.text
        return (await client.get("/users/me")).json()["user"]
