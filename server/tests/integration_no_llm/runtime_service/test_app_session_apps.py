"""运行时服务的会话归属：会话归开它的应用。别的应用的密钥对它的每个会话路由都答 404，报错同不存在的会话，
什么都不写；活动与占位只算自己的会话；别的应用的 id 开不走（409）。

应用 A 是 ``reader``（``app_client``），应用 B 是 ``bff``（``other_app``），两边代同一个属主。"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncGenerator, Callable
from typing import Any

import httpx
import pytest
from agent_runtime.harness.sessions import PgSessionStore
from fastapi import FastAPI
from pydantic_ai.models import Model
from sqlalchemy.ext.asyncio import AsyncEngine

from tests.helpers.app import TEST_MODEL_NAME
from tests.helpers.runtime import waits
from tests.helpers.runtime_service import (
    ADMIN_KEY,
    add_model,
    connect_provider,
    publish_agent,
    settled,
)

AGENT = "director"
IMAGE = "https://bkt.oss-ap-southeast-1.aliyuncs.com/style.jpg"
NOT_FOUND = {"detail": "没有这段会话"}


@pytest.fixture
def entered() -> asyncio.Event:
    return asyncio.Event()


@pytest.fixture
def gate() -> asyncio.Event:
    return asyncio.Event()


@pytest.fixture
def models(entered: asyncio.Event, gate: asyncio.Event) -> dict[str, Model]:
    return {TEST_MODEL_NAME: waits(entered, gate)}


@pytest.fixture
async def other_app(runtime_app: FastAPI, owner: uuid.UUID) -> AsyncGenerator[httpx.AsyncClient]:
    """另一个应用 ``bff``，代同一个属主；路径相对 ``/v1``。"""

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=runtime_app),
        base_url="http://runtime.test/v1",
        headers={"Authorization": f"Bearer {ADMIN_KEY}", "X-End-User": str(owner)},
    ) as client:
        yield client


async def open_session(client: httpx.AsyncClient, session_id: str | None = None) -> str:
    session_id = session_id or str(uuid.uuid4())
    opened = await client.post("/sessions", json={"id": session_id, "agent_id": AGENT})
    assert opened.status_code == 204, opened.text
    return session_id


@pytest.fixture
async def published(admin: httpx.AsyncClient) -> None:
    provider_id = await connect_provider(admin)
    await add_model(admin, provider_id, TEST_MODEL_NAME)
    await publish_agent(admin, AGENT)


@pytest.fixture
async def theirs(published: None, app_client: httpx.AsyncClient) -> str:
    """应用 A 的会话，工作区里有一份文件、台账里有一条素材。"""

    session_id = await open_session(app_client)
    written = await app_client.put(f"/sessions/{session_id}/files/brief.md", json={"content": "A"})
    assert written.status_code == 200, written.text
    recorded = await app_client.post(
        f"/sessions/{session_id}/materials", json={"materials": [{"url": IMAGE, "kind": "image"}]}
    )
    assert recorded.status_code == 204, recorded.text
    return session_id


Request = tuple[str, str, dict[str, Any] | None, dict[str, str] | None]
"""（方法，路径，请求体，查询参数）。"""


def _requests(owner: uuid.UUID) -> dict[str, Callable[[str, str], Request]]:
    """每个带会话 id 的路由，按（会话 id，调用方自己的另一个会话 id）拼出一次请求。"""

    prompt = {
        "prompt_id": "prm_x",
        "content": [{"type": "text", "text": "你好"}],
        "user_name": "logan",
        "agent_id": AGENT,
    }
    return {
        "submit": lambda s, _: ("POST", f"/sessions/{s}/prompts", prompt, None),
        "queue": lambda s, _: ("GET", f"/sessions/{s}/prompts", None, None),
        "status": lambda s, _: ("GET", f"/sessions/{s}/status", None, None),
        "abort-prompt": lambda s, _: ("POST", f"/sessions/{s}/prompts/prm_x:abort", None, None),
        "abort-session": lambda s, _: ("POST", f"/sessions/{s}:abort", None, None),
        "regenerate": lambda s, _: ("POST", f"/sessions/{s}/turns/t1:regenerate", None, None),
        "steer": lambda s, _: (
            "POST",
            f"/sessions/{s}/prompts:steer",
            {"prompt_ids": ["prm_x"]},
            None,
        ),
        "approve": lambda s, _: (
            "POST",
            f"/sessions/{s}/interactions/int_1",
            {"approved": True},
            None,
        ),
        "transcript": lambda s, _: (
            "GET",
            f"/sessions/{s}/transcript",
            None,
            {"session_agent": AGENT},
        ),
        "ops": lambda s, _: ("GET", f"/sessions/{s}/transcript/ops", None, {"since_seq": "0"}),
        "list-files": lambda s, _: ("GET", f"/sessions/{s}/files", None, None),
        "read-file": lambda s, _: ("GET", f"/sessions/{s}/files/brief.md", None, None),
        "write-file": lambda s, _: ("PUT", f"/sessions/{s}/files/brief.md", {"content": "B"}, None),
        "record-materials": lambda s, _: (
            "POST",
            f"/sessions/{s}/materials",
            {"materials": [{"url": "https://cdn.test/b.png", "kind": "image"}]},
            None,
        ),
        "lookup-material": lambda s, _: ("GET", f"/sessions/{s}/materials", None, {"url": IMAGE}),
        "lookup-materials": lambda s, _: (
            "POST",
            f"/sessions/{s}/materials:lookup",
            {"urls": [IMAGE]},
            None,
        ),
        "fork": lambda s, _: (
            "POST",
            f"/sessions/{s}:fork",
            {"target_id": str(uuid.uuid4()), "source_user": str(owner), "turn": 1},
            None,
        ),
        "copy-files": lambda s, mine: (
            "POST",
            f"/sessions/{s}/files:copy",
            {"target_id": mine, "source_user": str(owner), "files": [["brief.md", "brief.md"]]},
            None,
        ),
    }


async def call(client: httpx.AsyncClient, request: Request) -> httpx.Response:
    method, path, body, params = request
    return await client.request(method, path, json=body, params=params)


async def test_another_apps_session_is_404_like_a_missing_one_and_left_alone(
    app_client: httpx.AsyncClient,
    other_app: httpx.AsyncClient,
    owner: uuid.UUID,
    theirs: str,
) -> None:
    mine = await open_session(other_app)
    missing_id = str(uuid.uuid4())
    for route, build in _requests(owner).items():
        foreign = await call(other_app, build(theirs, mine))
        missing = await call(other_app, build(missing_id, mine))

        assert (foreign.status_code, foreign.json()) == (404, NOT_FOUND), route
        assert (missing.status_code, missing.json()) == (404, NOT_FOUND), route
    # B 的请求没碰 A 的东西：文件、素材、队列都还是 A 自己写的那些。
    kept = await app_client.get(f"/sessions/{theirs}/files/brief.md")
    assert kept.json()["content"] == "A"
    stranger = await app_client.get(
        f"/sessions/{theirs}/materials", params={"url": "https://cdn.test/b.png"}
    )
    assert stranger.status_code == 404
    assert (await app_client.get(f"/sessions/{theirs}/prompts")).json() == {
        "active": None,
        "queued": [],
    }


async def test_copy_files_into_another_apps_session_is_404_and_writes_nothing(
    app_client: httpx.AsyncClient, other_app: httpx.AsyncClient, owner: uuid.UUID, theirs: str
) -> None:
    mine = await open_session(other_app)
    await other_app.put(f"/sessions/{mine}/files/film.icml", json={"content": "B 的工程"})

    copied = await other_app.post(
        f"/sessions/{mine}/files:copy",
        json={"target_id": theirs, "source_user": str(owner), "files": [["film.icml", "x.icml"]]},
    )

    assert (copied.status_code, copied.json()) == (404, NOT_FOUND)
    listed = await app_client.get(f"/sessions/{theirs}/files")
    assert [entry["path"] for entry in listed.json()["files"]] == ["brief.md"]


async def test_an_id_another_app_holds_cannot_be_opened_and_stays_theirs(
    app_client: httpx.AsyncClient, other_app: httpx.AsyncClient, theirs: str
) -> None:
    taken = await other_app.post("/sessions", json={"id": theirs, "agent_id": AGENT})

    assert taken.status_code == 409
    assert taken.json() == {"detail": "这个会话 id 已经被别的应用用了，换一个"}
    assert (await app_client.get(f"/sessions/{theirs}/status")).status_code == 200
    assert (await other_app.get(f"/sessions/{theirs}/status")).json() == NOT_FOUND
    # 同一个应用重开自己的 id 照旧可以。
    await open_session(app_client, theirs)


async def test_activities_and_busy_count_only_the_callers_sessions(
    running: None,
    app_client: httpx.AsyncClient,
    other_app: httpx.AsyncClient,
    theirs: str,
    entered: asyncio.Event,
    gate: asyncio.Event,
) -> None:
    mine = await open_session(other_app)
    sent = await app_client.post(
        f"/sessions/{theirs}/prompts",
        json={
            "prompt_id": "prm_first",
            "content": [{"type": "text", "text": "第一问"}],
            "user_name": "logan",
            "agent_id": AGENT,
        },
    )
    assert sent.status_code == 200, sent.text
    await asyncio.wait_for(entered.wait(), timeout=10)

    asked = {"ids": [theirs, mine]}
    for_b = await other_app.post("/sessions:activities", json=asked)
    for_a = await app_client.post("/sessions:activities", json=asked)
    assert for_b.json() == {
        "items": {mine: {"busy": False, "pending_interaction": "none", "last_turn_reason": None}}
    }
    assert for_a.json() == {
        "items": {theirs: {"busy": True, "pending_interaction": "none", "last_turn_reason": None}}
    }
    assert (await other_app.get("/sessions:busy")).json() == {"ids": []}
    assert (await app_client.get("/sessions:busy")).json() == {"ids": [theirs]}

    gate.set()
    await settled(app_client, theirs)


async def test_the_store_keeps_each_id_with_the_app_that_opened_it(engine: AsyncEngine) -> None:
    """开与照抄都按归属写：同一应用重开改版本、照抄到已有的保持原样，别的应用的 id 什么都不写。"""

    store = PgSessionStore(engine)
    source, held, fresh = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()

    assert await store.open(source, app_id="video", agent_version_id=None)
    assert await store.open(held, app_id="shop", agent_version_id=None)
    assert await store.open(source, app_id="video", agent_version_id=None)
    assert not await store.open(held, app_id="video", agent_version_id=None)
    assert not await store.copy(source, held, app_id="video")
    assert await store.copy(source, fresh, app_id="video")
    assert await store.copy(source, fresh, app_id="video")

    assert await store.owned([source, held, fresh, uuid.uuid4()], app_id="video") == {
        source,
        fresh,
    }
    assert await store.owned([source, held], app_id="shop") == {held}
    assert await store.owned([], app_id="video") == frozenset()
