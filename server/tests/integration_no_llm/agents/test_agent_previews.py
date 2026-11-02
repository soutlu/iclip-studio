"""agent 测试预览：开预览要 ``agent:manage``，每人每个 agent 只有一段当前预览，开新的先中断、再换掉旧的；
预览 id 当对话 id 用在 transcript、发消息、状态、队列、读工作区文件与订阅上，只认属主本人、且他此刻持
``agent:manage``，治理者也不例外，换掉的那段对谁都是 404；预览不是对话，不进列表、不起名，活动帧谁都不发。

几个人：属主与另一位管理员是 editor 外加直接授的 ``agent:manage``，治理者是 editor 外加 ``users:manage``。"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from collections.abc import AsyncGenerator, AsyncIterator, Callable
from typing import Any

import httpx
import pytest
from agent_runtime.client import RuntimeClient, RuntimeUnavailable
from agent_runtime.plugins.base import PluginRegistry
from agent_runtime.transcript.ops import MAIN_AGENT_ID
from fastapi import FastAPI
from pydantic_ai.capabilities import Capability
from pydantic_ai.messages import ModelMessage
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.tools import Tool
from sqlalchemy import text
from starlette.testclient import TestClient

from tests.helpers.agents import AgentSeed
from tests.helpers.app import TEST_MODEL_NAME, make_client, new_conversation, settled
from tests.helpers.auth import register_and_login
from tests.helpers.pg import connected
from tests.helpers.plugins import FixedPlugin
from tests.helpers.ws import AGENT_ID, open_conversation, sign_in_as, until

PROMPT = {"prompt_id": "prm_preview", "content": [{"type": "text", "text": "试一下"}]}
OTHER_AGENT = "director"


@pytest.fixture
def agent_seeds() -> tuple[AgentSeed, ...]:
    return (AgentSeed(AGENT_ID), AgentSeed(OTHER_AGENT))


async def grant(pg_url: str, username: str, permissions: list[str]) -> None:
    """``username`` 是 editor，另直接授 ``permissions``（替换原有的直接授权）。"""

    async with connected(pg_url) as conn:
        await conn.execute(
            text(
                "UPDATE iclip.users SET roles = '[\"editor\"]'::jsonb,"
                " direct_permissions = CAST(:p AS jsonb) WHERE username = :u"
            ),
            {"p": json.dumps(permissions), "u": username},
        )


ROLES: dict[str, list[str]] = {
    "owner": ["agent:manage"],
    "other_admin": ["agent:manage"],
    "governor": ["users:manage"],
    "plain": [],
}


@pytest.fixture
async def people(app: FastAPI, pg_url: str) -> AsyncGenerator[dict[str, httpx.AsyncClient]]:
    """每人一个登录好的客户端。"""

    clients: dict[str, httpx.AsyncClient] = {}
    try:
        for name, permissions in ROLES.items():
            client = make_client(app)
            await client.__aenter__()
            clients[name] = client
            await register_and_login(client, username=name, email=f"{name}@example.com")
            await grant(pg_url, name, permissions)
        yield clients
    finally:
        for client in clients.values():
            await client.__aexit__(None, None, None)


async def open_preview(
    client: httpx.AsyncClient, agent_id: str = AGENT_ID, body: dict[str, Any] | None = None
) -> httpx.Response:
    return await client.post(f"/agents/{agent_id}/previews", json=body)


async def a_preview(client: httpx.AsyncClient, agent_id: str = AGENT_ID) -> str:
    opened = await open_preview(client, agent_id)
    assert opened.status_code == 201, opened.text
    return str(opened.json()["id"])


async def test_opening_a_preview_needs_agent_manage(people: dict[str, httpx.AsyncClient]) -> None:
    for name in ("governor", "plain"):
        refused = await open_preview(people[name])
        assert refused.status_code == 403, name


async def test_a_preview_of_the_draft_or_of_a_version_of_an_existing_agent(
    people: dict[str, httpx.AsyncClient],
) -> None:
    owner = people["owner"]
    version_id = (await owner.get(f"/agents/{AGENT_ID}")).json()["activeVersion"]["id"]

    draft = await open_preview(owner)
    pinned = await open_preview(owner, body={"versionId": version_id})
    missing = await open_preview(owner, "nobody")
    foreign = await open_preview(owner, body={"versionId": str(uuid.uuid4())})

    assert draft.status_code == 201, draft.text
    assert set(draft.json()) == {"id", "agentId", "versionId", "createdAt"}
    assert (draft.json()["agentId"], draft.json()["versionId"]) == (AGENT_ID, None)
    assert (pinned.status_code, pinned.json()["versionId"]) == (201, version_id)
    assert missing.status_code == 404
    assert (foreign.status_code, foreign.json()) == (
        422,
        {"detail": f"这个版本不是 {AGENT_ID} 的"},
    )


Route = Callable[[str], tuple[str, str, dict[str, Any] | None]]
"""按会话 id 拼出（方法，路径，请求体）。"""

ROUTES: dict[str, Route] = {
    "transcript": lambda s: ("GET", f"/conversations/{s}/transcript", None),
    "ops": lambda s: ("GET", f"/conversations/{s}/transcript/ops?since_seq=0", None),
    "status": lambda s: ("GET", f"/conversations/{s}/status", None),
    "queue": lambda s: ("GET", f"/conversations/{s}/prompts", None),
    "files": lambda s: ("GET", f"/conversations/{s}/workspace/files", None),
    "send": lambda s: (
        "POST",
        f"/conversations/{s}/prompts",
        {"prompt_id": f"prm_{uuid.uuid4().hex[:8]}", "content": PROMPT["content"]},
    ),
    "abort": lambda s: ("POST", f"/conversations/{s}:abort", None),
}


async def call(client: httpx.AsyncClient, route: Route, session_id: str) -> int:
    method, path, body = route(session_id)
    answer = await client.request(method, path, json=body)
    return answer.status_code


async def statuses(client: httpx.AsyncClient, session_id: str) -> dict[str, int]:
    """每个路由各调一次的状态码；发得出消息就等它收完尾，免得下一位撞上在跑的那条。"""

    found = {name: await call(client, route, session_id) for name, route in ROUTES.items()}
    if found["send"] == 200:
        await settled(client, session_id)
    return found


ALL_OK = dict.fromkeys(ROUTES, 200) | {"abort": 204}
ALL_HIDDEN = dict.fromkeys(ROUTES, 404)


async def test_only_the_owner_holding_agent_manage_reaches_a_preview(
    people: dict[str, httpx.AsyncClient], pg_url: str
) -> None:
    owner = people["owner"]
    preview = await a_preview(owner)
    conversation = await new_conversation(owner, AGENT_ID)

    assert await statuses(owner, preview) == ALL_OK
    for name in ("other_admin", "governor", "plain"):
        assert await statuses(people[name], preview) == ALL_HIDDEN, name
    # 对话照原来的口径：治理者读得到别人的对话、写不了，别的管理员读不到。
    governor_on_conversation = await statuses(people["governor"], conversation)
    assert {k: governor_on_conversation[k] for k in ("transcript", "status", "files")} == {
        "transcript": 200,
        "status": 200,
        "files": 200,
    }
    assert governor_on_conversation["send"] == 404
    assert await statuses(people["other_admin"], conversation) == ALL_HIDDEN

    # 属主不再持 agent:manage：预览就此认不得，自己的对话照旧。
    await grant(pg_url, "owner", [])
    assert await statuses(owner, preview) == ALL_HIDDEN
    assert await statuses(owner, conversation) == ALL_OK


async def test_a_preview_runs_with_a_fixed_title_and_stays_out_of_the_conversation_list(
    people: dict[str, httpx.AsyncClient],
) -> None:
    owner = people["owner"]
    preview = await a_preview(owner)

    sent = await owner.post(f"/conversations/{preview}/prompts", json=PROMPT)
    assert sent.status_code == 200, sent.text
    await settled(owner, preview)
    page = (await owner.get(f"/conversations/{preview}/transcript")).json()
    row = await owner.get(f"/conversations/{preview}")
    sidebar = (await owner.get("/conversations")).json()

    assert [turn["turnId"] for turn in page["items"]] == ["t1"]
    assert (await owner.get(f"/conversations/{preview}/status")).json() == {"status": "completed"}
    assert page["title"] == "测试预览"
    assert page["owner_user_id"] == (await owner.get("/users/me")).json()["user"]["id"]
    assert (page["deleted_at"], page["forked_from"]) == (None, None)
    assert row.status_code == 404
    assert sidebar["ungroupedCount"] == 0


async def test_opening_again_replaces_the_current_preview_and_the_old_one_is_gone(
    people: dict[str, httpx.AsyncClient], pg_url: str
) -> None:
    owner = people["owner"]
    old = await a_preview(owner)
    new = await a_preview(owner)

    assert new != old
    assert await _preview_rows(pg_url) == {(new, "owner", AGENT_ID, None)}
    assert await statuses(owner, old) == ALL_HIDDEN
    assert await statuses(owner, new) == ALL_OK
    # 换掉的那段在运行时那边的会话留着，只是再也寻址不到。
    assert {old, new} <= await _preview_sessions(pg_url)


async def test_a_version_preview_replaces_the_draft_preview(
    people: dict[str, httpx.AsyncClient], pg_url: str
) -> None:
    owner = people["owner"]
    version_id = (await owner.get(f"/agents/{AGENT_ID}")).json()["activeVersion"]["id"]
    draft = await a_preview(owner)

    pinned = await open_preview(owner, body={"versionId": version_id})

    assert pinned.status_code == 201, pinned.text
    assert await _preview_rows(pg_url) == {(pinned.json()["id"], "owner", AGENT_ID, version_id)}
    assert (await owner.get(f"/conversations/{draft}/status")).status_code == 404


async def test_each_person_has_one_current_preview_per_agent(
    people: dict[str, httpx.AsyncClient], pg_url: str
) -> None:
    owner, other = people["owner"], people["other_admin"]
    mine = await a_preview(owner)
    theirs = await a_preview(other)
    mine_elsewhere = await a_preview(owner, OTHER_AGENT)

    assert await _preview_rows(pg_url) == {
        (mine, "owner", AGENT_ID, None),
        (theirs, "other_admin", AGENT_ID, None),
        (mine_elsewhere, "owner", OTHER_AGENT, None),
    }
    for client, preview in ((owner, mine), (other, theirs), (owner, mine_elsewhere)):
        assert (await client.get(f"/conversations/{preview}/status")).status_code == 200


async def test_a_failed_abort_keeps_the_current_preview(
    people: dict[str, httpx.AsyncClient], pg_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    owner = people["owner"]
    current = await a_preview(owner)
    rows = await _preview_rows(pg_url)
    sessions = await _preview_sessions(pg_url)

    async def unavailable(_self: RuntimeClient, _session_id: uuid.UUID) -> None:
        raise RuntimeUnavailable("运行时暂时不可用")

    with monkeypatch.context() as patch:
        patch.setattr(RuntimeClient, "abort_session", unavailable)
        refused = await open_preview(owner)

    assert refused.status_code == 503, refused.text
    assert await _preview_rows(pg_url) == rows
    assert (await owner.get(f"/conversations/{current}/status")).status_code == 200
    # 中断之前开好的那段没有行指着它，谁都寻址不到。
    (leftover,) = await _preview_sessions(pg_url) - sessions
    assert leftover not in {row[0] for row in rows}
    assert (await owner.get(f"/conversations/{leftover}/status")).status_code == 404
    retried = await open_preview(owner)
    assert retried.status_code == 201, retried.text
    assert await _preview_rows(pg_url) == {(retried.json()["id"], "owner", AGENT_ID, None)}


async def test_concurrent_opens_leave_exactly_one_current_preview(
    people: dict[str, httpx.AsyncClient], pg_url: str
) -> None:
    owner = people["owner"]
    # 第一轮还没有当前预览，两次都是新落行；第二轮两次都要先中断同一段再换掉它。
    for _ in range(2):
        first, second = await asyncio.gather(open_preview(owner), open_preview(owner))

        assert (first.status_code, second.status_code) == (201, 201), (first.text, second.text)
        opened = {str(first.json()["id"]), str(second.json()["id"])}
        rows = await _preview_rows(pg_url)
        assert len(rows) == 1
        ((kept, _, _, _),) = rows
        (lost,) = opened - {kept}
        assert (await owner.get(f"/conversations/{lost}/status")).status_code == 404
        assert (await owner.get(f"/conversations/{kept}/status")).status_code == 200


class TestReplacingAnActivePreview:
    @pytest.fixture
    def model_entered(self) -> asyncio.Event:
        return asyncio.Event()

    @pytest.fixture
    def model_released(self) -> asyncio.Event:
        return asyncio.Event()

    @pytest.fixture
    def models(
        self, model_entered: asyncio.Event, model_released: asyncio.Event
    ) -> dict[str, FunctionModel]:
        async def respond(_messages: list[ModelMessage], _info: AgentInfo) -> AsyncIterator[str]:
            yield "正在生成"
            model_entered.set()
            await model_released.wait()
            yield "完成"

        return {TEST_MODEL_NAME: FunctionModel(stream_function=respond)}

    async def test_replacing_stops_the_active_prompt_and_discards_the_queue(
        self,
        people: dict[str, httpx.AsyncClient],
        pg_url: str,
        model_entered: asyncio.Event,
        model_released: asyncio.Event,
    ) -> None:
        owner = people["owner"]
        preview = await a_preview(owner)
        try:
            sent = await owner.post(f"/conversations/{preview}/prompts", json=PROMPT)
            assert sent.status_code == 200, sent.text
            await asyncio.wait_for(model_entered.wait(), timeout=5)
            queued = await owner.post(
                f"/conversations/{preview}/prompts",
                json={**PROMPT, "prompt_id": "prm_queued"},
            )
            assert queued.status_code == 200, queued.text
            assert await _prompt_states(pg_url, preview) == {
                "prm_preview": "running",
                "prm_queued": "queued",
            }

            # 别人在同一个 agent 上开、属主在别的 agent 上开：都不换掉这一段，也不打断它。
            for client, agent_id in ((people["other_admin"], AGENT_ID), (owner, OTHER_AGENT)):
                elsewhere = await open_preview(client, agent_id)
                assert elsewhere.status_code == 201, elsewhere.text
                assert await _prompt_states(pg_url, preview) == {
                    "prm_preview": "running",
                    "prm_queued": "queued",
                }

            replaced = await open_preview(owner)
            assert replaced.status_code == 201, replaced.text
            await _wait_for_prompt_states(
                pg_url, preview, {"prm_preview": "aborted", "prm_queued": "aborted"}
            )
            assert (await owner.get(f"/conversations/{preview}/status")).status_code == 404
        finally:
            model_released.set()

    async def test_a_target_refused_by_the_runtime_leaves_the_current_preview_running(
        self,
        people: dict[str, httpx.AsyncClient],
        pg_url: str,
        model_entered: asyncio.Event,
        model_released: asyncio.Event,
    ) -> None:
        owner = people["owner"]
        preview = await a_preview(owner)
        try:
            sent = await owner.post(f"/conversations/{preview}/prompts", json=PROMPT)
            assert sent.status_code == 200, sent.text
            await asyncio.wait_for(model_entered.wait(), timeout=5)
            queued = await owner.post(
                f"/conversations/{preview}/prompts",
                json={**PROMPT, "prompt_id": "prm_queued"},
            )
            assert queued.status_code == 200, queued.text
            rows = await _preview_rows(pg_url)

            foreign = await open_preview(owner, body={"versionId": str(uuid.uuid4())})

            assert foreign.status_code == 422, foreign.text
            assert await _preview_rows(pg_url) == rows
            assert await _prompt_states(pg_url, preview) == {
                "prm_preview": "running",
                "prm_queued": "queued",
            }
            assert (await owner.get(f"/conversations/{preview}/status")).status_code == 200
        finally:
            model_released.set()


class TestReplacingAnAwaitingPreview:
    @pytest.fixture
    def agent_seeds(self) -> tuple[AgentSeed, ...]:
        return (AgentSeed(AGENT_ID, plugins=("approval",)),)

    @pytest.fixture
    def runtime_plugins(self) -> PluginRegistry:
        def approved_action() -> str:
            return "已执行"

        capability = Capability[Any](
            id="approval", tools=[Tool(approved_action, requires_approval=True)]
        )
        return {"approval": FixedPlugin.bind(name="approval", capabilities=(capability,))}

    async def test_replacing_cancels_the_pending_approval_and_discards_the_queue(
        self, people: dict[str, httpx.AsyncClient], pg_url: str, app: FastAPI
    ) -> None:
        owner = people["owner"]
        preview = await a_preview(owner)
        sent = await owner.post(f"/conversations/{preview}/prompts", json=PROMPT)
        assert sent.status_code == 200, sent.text
        await _wait_for_prompt_states(pg_url, preview, {"prm_preview": "awaiting"})
        queued = await owner.post(
            f"/conversations/{preview}/prompts", json={**PROMPT, "prompt_id": "prm_queued"}
        )
        assert queued.status_code == 200, queued.text
        assert app.state.transcript_store.pending_interactions(preview, MAIN_AGENT_ID)

        replaced = await open_preview(owner)

        assert replaced.status_code == 201, replaced.text
        await _wait_for_prompt_states(
            pg_url, preview, {"prm_preview": "aborted", "prm_queued": "aborted"}
        )
        assert app.state.transcript_store.pending_interactions(preview, MAIN_AGENT_ID) == ()
        assert (await owner.get(f"/conversations/{preview}/status")).status_code == 404


async def _preview_rows(pg_url: str) -> set[tuple[str, str, str, str | None]]:
    """``iclip.agent_previews`` 的每一行：（预览 id，属主用户名，agent，版本 id）。"""

    async with connected(pg_url) as conn:
        rows = await conn.execute(
            text(
                "SELECT p.id, u.username, p.agent_id, p.version_id FROM iclip.agent_previews p"
                " JOIN iclip.users u ON u.id = p.owner_user_id"
            )
        )
        return {
            (
                str(row.id),
                row.username,
                row.agent_id,
                None if row.version_id is None else str(row.version_id),
            )
            for row in rows
        }


async def _preview_sessions(pg_url: str) -> set[str]:
    """运行时那边全部预览会话的 id。"""

    async with connected(pg_url) as conn:
        rows = await conn.execute(
            text("SELECT id FROM agent_runtime.sessions WHERE preview_agent_id IS NOT NULL")
        )
        return {str(row.id) for row in rows}


async def _wait_for_prompt_states(pg_url: str, preview: str, expected: dict[str, str]) -> None:
    states: dict[str, str] = {}
    for _ in range(200):
        states = await _prompt_states(pg_url, preview)
        if states == expected:
            return
        await asyncio.sleep(0.02)
    assert states == expected


async def _prompt_states(pg_url: str, preview: str) -> dict[str, str]:
    async with connected(pg_url) as conn:
        rows = await conn.execute(
            text(
                "SELECT prompt_id, status FROM agent_runtime.agent_jobs"
                " WHERE conversation_id = :preview"
            ),
            {"preview": preview},
        )
        return {row.prompt_id: row.status for row in rows}


# --- 订阅与活动帧 ------------------------------------------------------------------


def _grant_sync(pg_url: str, username: str, permissions: list[str]) -> None:
    asyncio.run(grant(pg_url, username, permissions))


def test_subscribing_to_a_preview_is_for_its_owner_and_its_activity_reaches_nobody(
    ws_agent_app: FastAPI, pg_url: str
) -> None:
    with TestClient(ws_agent_app) as tc:
        owner = sign_in_as(tc, pg_url, username="owner", roles=("editor",))
        governor = sign_in_as(tc, pg_url, username="governor", roles=("editor",))
        _grant_sync(pg_url, "owner", ["agent:manage"])
        _grant_sync(pg_url, "governor", ["users:manage"])
        opened = tc.post(f"/agents/{AGENT_ID}/previews", headers=owner)
        assert opened.status_code == 201, opened.text
        preview = opened.json()["id"]
        conversation = open_conversation(tc, headers=owner)

        with (
            tc.websocket_connect("/ws", headers=owner) as mine,
            tc.websocket_connect("/ws", headers=governor) as theirs,
        ):
            for ws in (mine, theirs):
                assert ws.receive_json()["type"] == "server_hello"
                ws.send_json(
                    {
                        "type": "subscribe_v2",
                        "id": "s1",
                        "payload": {"session_id": preview, "transcript": {"main": "off"}},
                    }
                )
            assert until(mine, "ack")["payload"]["accepted"] == [preview]
            assert until(theirs, "ack")["payload"]["not_found"] == [preview]

            # 先跑预览、再跑对话：两条连接上第一帧活动都该是对话的，预览的一帧都没有。
            for session_id, prompt_id in ((preview, "prm_p"), (conversation, "prm_c")):
                sent = tc.post(
                    f"/conversations/{session_id}/prompts",
                    json={"prompt_id": prompt_id, "content": PROMPT["content"]},
                    headers=owner,
                )
                assert sent.status_code == 200, sent.text
                _settled(tc, session_id, owner)
            for ws in (mine, theirs):
                first = until(ws, "event.session.work_changed")
                assert first["session_id"] == conversation


def test_a_replaced_preview_can_no_longer_be_subscribed(ws_agent_app: FastAPI, pg_url: str) -> None:
    with TestClient(ws_agent_app) as tc:
        owner = sign_in_as(tc, pg_url, username="owner", roles=("editor",))
        _grant_sync(pg_url, "owner", ["agent:manage"])
        opened = [tc.post(f"/agents/{AGENT_ID}/previews", headers=owner) for _ in range(2)]
        assert [answer.status_code for answer in opened] == [201, 201]
        old, new = (answer.json()["id"] for answer in opened)

        with tc.websocket_connect("/ws", headers=owner) as ws:
            assert ws.receive_json()["type"] == "server_hello"
            acks: list[dict[str, Any]] = []
            for frame_id, session_id in (("s1", old), ("s2", new)):
                ws.send_json(
                    {
                        "type": "subscribe_v2",
                        "id": frame_id,
                        "payload": {"session_id": session_id, "transcript": {"main": "off"}},
                    }
                )
                acks.append(until(ws, "ack")["payload"])

        found = [(ack.get("accepted", []), ack.get("not_found", [])) for ack in acks]
        assert found == [([], [old]), ([new], [])]


def _settled(tc: TestClient, session_id: str, headers: dict[str, str], tries: int = 200) -> None:
    for _ in range(tries):
        queue = tc.get(f"/conversations/{session_id}/prompts", headers=headers).json()
        if queue["active"] is None and not queue["queued"]:
            return
        time.sleep(0.02)
    raise AssertionError("没跑完")
