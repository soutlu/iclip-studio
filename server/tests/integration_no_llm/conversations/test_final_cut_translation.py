"""翻译接口装进整个应用以后：真的登录与角色、真的对话行；校验与模型出错的各种答复在单测里。"""

from __future__ import annotations

import json
from collections.abc import AsyncGenerator
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncEngine

from tests.helpers.agents import CONVERSABLE_SEEDS, seed_agents
from tests.helpers.app import make_client, make_runtime_config
from tests.helpers.auth import login_as_editor, register_and_login, set_roles_in_db
from tests.helpers.model_groups import MKT, MKT_DEPARTMENT, set_departments, with_model_groups
from tests.helpers.model_providers import GOOD_KEY, KeyCheckingProbe
from tests.helpers.references import FakeArk, ark_translator, responses_body
from tests.helpers.runtime_backed import build_backed_app, config_services_of

URL = "/conversations"

ENTRIES = [{"id": "c2", "text": "第二句"}, {"id": "c1", "text": "第一句\n换行"}]


@pytest.fixture
def ark() -> FakeArk:
    return FakeArk()


@pytest.fixture
async def translate_app(
    base_env: None, engine: AsyncEngine, ark: FakeArk, tmp_path: Path
) -> FastAPI:
    built = build_backed_app(
        with_model_groups(make_runtime_config(), {MKT: [MKT_DEPARTMENT]}),
        engine=engine,
        credential_probe=KeyCheckingProbe({GOOD_KEY}),
        skill_cache_dir=tmp_path / "skills",
        final_cut_translator=ark_translator(ark),
    )
    await seed_agents(config_services_of(built), engine, CONVERSABLE_SEEDS)
    return built


@pytest.fixture
async def client(translate_app: FastAPI) -> AsyncGenerator[httpx.AsyncClient]:
    async with make_client(translate_app) as http:
        yield http


async def open_conversation(client: httpx.AsyncClient) -> str:
    opened = await client.post(URL, json={"agentId": "storyboard"})
    assert opened.status_code == 201, opened.text
    return str(opened.json()["conversation"]["id"])


async def translate(client: httpx.AsyncClient, conversation_id: str) -> httpx.Response:
    return await client.post(
        f"{URL}/{conversation_id}/final-cut/translations",
        json={"targetLocale": "de", "entries": ENTRIES},
    )


async def test_the_owner_gets_translations_in_request_order_and_nothing_is_written(
    client: httpx.AsyncClient, ark: FakeArk, pg_url: str
) -> None:
    await login_as_editor(client, pg_url)
    mine = await open_conversation(client)
    raw = json.dumps(
        {
            "translations": [
                {"id": "c1", "text": "Erster Satz\nUmbruch"},
                {"id": "c2", "text": "Zweiter Satz"},
            ]
        }
    )
    ark.tag = httpx.Response(200, json=responses_body(raw))

    answered = await translate(client, mine)

    assert answered.status_code == 200, answered.text
    assert answered.json() == {
        "translations": [
            {"id": "c2", "text": "Zweiter Satz"},
            {"id": "c1", "text": "Erster Satz\nUmbruch"},
        ]
    }
    (sent,) = ark.tag_requests
    assert "德语" in sent["input"][0]["content"][0]["text"]
    files = (await client.get(f"{URL}/{mine}/workspace/files")).json()["files"]
    assert files == [], "翻译不写工作区"


@pytest.mark.parametrize(
    ("departments", "expected"),
    [([MKT_DEPARTMENT], MKT), ([], None)],
    ids=["owner_in_mkt", "owner_in_default_group"],
)
async def test_the_translation_uses_the_owners_model_group(
    client: httpx.AsyncClient,
    ark: FakeArk,
    engine: AsyncEngine,
    pg_url: str,
    departments: list[int],
    expected: str | None,
) -> None:
    owner = await login_as_editor(client, pg_url)
    await set_departments(engine, owner, departments)
    mine = await open_conversation(client)
    raw = json.dumps({"translations": [{"id": "c1", "text": "A"}, {"id": "c2", "text": "B"}]})
    ark.tag = httpx.Response(200, json=responses_body(raw))

    assert (await translate(client, mine)).status_code == 200

    assert [call["model_group"] for call in ark.calls] == [expected]


async def test_only_the_owner_of_a_live_conversation_translates(
    translate_app: FastAPI, client: httpx.AsyncClient, ark: FakeArk, pg_url: str
) -> None:
    await login_as_editor(client, pg_url)
    mine = await open_conversation(client)
    doomed = await open_conversation(client)
    assert (await client.delete(f"{URL}/{doomed}")).status_code == 204

    assert (await translate(client, doomed)).status_code == 404
    async with make_client(translate_app) as stranger:
        await login_as_editor(stranger, pg_url, username="mallory")
        assert (await translate(stranger, mine)).status_code == 404
    async with make_client(translate_app) as governor:
        await register_and_login(governor, username="gov", email="gov@example.com")
        await set_roles_in_db(pg_url, "gov@example.com", ["root"])
        assert (await translate(governor, mine)).status_code == 403

    assert ark.tag_requests == [], "没有权限的请求不调模型"
