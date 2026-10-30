"""运行时服务给应用的 agent 名册与起标题：名册只列上菜单、发布过的，第一个是默认项；没设默认对话模型时
不起标题，设了就用它起。会话接口要应用密钥，不要管理权限。"""

from __future__ import annotations

import httpx
import pytest
from pydantic_ai.models import Model
from pydantic_ai.models.test import TestModel

from tests.helpers.app import TEST_MODEL_NAME
from tests.helpers.runtime_service import (
    ADMIN_KEY,
    add_model,
    connect_provider,
    publish_agent,
)


@pytest.fixture
def models() -> dict[str, Model]:
    return {TEST_MODEL_NAME: TestModel(custom_output_text="「连衣裙短视频」")}


async def test_the_directory_lists_listed_published_agents(
    admin: httpx.AsyncClient, app_client: httpx.AsyncClient
) -> None:
    assert (await app_client.get("/agents")).json() == {"items": [], "default": None}

    provider_id = await connect_provider(admin)
    await add_model(admin, provider_id, TEST_MODEL_NAME)
    await publish_agent(admin, "director")
    await publish_agent(admin, "storyboard")
    await publish_agent(admin, "shot-writer", listed=False)

    directory = await app_client.get("/agents")
    assert directory.status_code == 200, directory.text
    assert directory.json() == {
        "items": [
            {"id": "director", "name": "director"},
            {"id": "storyboard", "name": "storyboard"},
        ],
        "default": "director",
    }


async def test_titles_use_the_default_chat_model(
    admin: httpx.AsyncClient, app_client: httpx.AsyncClient
) -> None:
    body = {"text": "给新款连衣裙做一条 15 秒的短视频"}
    assert (await app_client.post("/titles", json=body)).json() == {"title": None}

    provider_id = await connect_provider(admin)
    await add_model(admin, provider_id, TEST_MODEL_NAME)
    chosen = await admin.put(
        "/default-models/llm", json={"providerId": provider_id, "modelName": TEST_MODEL_NAME}
    )
    assert chosen.status_code == 200, chosen.text

    titled = await app_client.post("/titles", json=body)
    assert titled.status_code == 200, titled.text
    assert titled.json() == {"title": "连衣裙短视频"}


async def test_app_routes_need_a_known_key_but_not_admin(
    anonymous: httpx.AsyncClient, app_client: httpx.AsyncClient
) -> None:
    missing = await anonymous.get("/v1/agents")
    wrong = await anonymous.get(
        "/v1/agents", headers={"Authorization": f"Bearer {ADMIN_KEY[:-1]}x"}
    )

    assert (missing.status_code, wrong.status_code) == (401, 401)
    assert set(missing.json()) == set(wrong.json()) == {"detail"}
    # app_client 用的是没有管理权限的应用。
    assert (await app_client.get("/agents")).status_code == 200
