"""爆款素材库端点：能否入选与三种 422、入选幂等、入选带人工标签并排一次打标、改标签与重新打标要先
入选且不在打标、移出连同标签、按标签筛选与翻页、标签树里的条数；没配打标时照样入选但不打标。

打标是替身，队列连接器是内存替身（不跑 lifespan，排进去的任务不执行），排了几次看连接器里的任务。"""

from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from procrastinate.testing import InMemoryConnector
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.app.bootstrap import build_app
from iclip.platform.db.engine import build_engine
from iclip.platform.media.codec import SOFTWARE
from tests.helpers.app import make_client
from tests.helpers.auth import set_roles_in_db
from tests.helpers.generation import MemoryObjectStore
from tests.helpers.hit_cases import (
    hit_case_rows,
    plant_conversation,
    plant_hit_case,
    plant_job,
    plant_material,
)
from tests.helpers.pg import reset_database
from tests.helpers.references import STUDIO_ENVS, FakeArk, ark_pipeline, config_with_studio
from tests.helpers.references import plant_user as plant_named_user
from tests.helpers.tagging import tag_id

PASSWORD = "password-123"
HIT_CASES = "/library/hit-cases"


@pytest.fixture
def connector() -> InMemoryConnector:
    return InMemoryConnector()


@pytest.fixture
async def studio_app(
    base_env: None,
    migrated_pg: str,
    monkeypatch: pytest.MonkeyPatch,
    connector: InMemoryConnector,
) -> AsyncGenerator[FastAPI]:
    """打标配好（拆解同一段配置）、媒体生成没开的 app。"""

    for name, value in STUDIO_ENVS.items():
        monkeypatch.setenv(name, value)
    monkeypatch.delenv("VIDEO_SUBMIT_URL", raising=False)
    engine = build_engine(migrated_pg)
    async with engine.begin() as conn:
        await reset_database(conn)
    breakdowns, tagger = ark_pipeline(FakeArk())
    try:
        yield build_app(
            config_with_studio(),
            engine=engine,
            object_store=MemoryObjectStore(),
            queue_connector=connector,
            reference_breakdowns=breakdowns,
            library_tagger=tagger,
            media_codec=SOFTWARE,
        )
    finally:
        await engine.dispose()


@pytest.fixture
async def http(studio_app: FastAPI) -> AsyncGenerator[httpx.AsyncClient]:
    async with make_client(studio_app) as client:
        yield client


async def login_as(client: httpx.AsyncClient, pg_url: str, username: str, role: str) -> None:
    """第一次叫到这个名字就注册，之后只是重新登录。"""

    email = f"{username}@example.com"
    created = await client.post(
        "/auth/register", json={"email": email, "password": PASSWORD, "username": username}
    )
    if created.status_code == 201:
        await set_roles_in_db(pg_url, email, [role])
    logged_in = await client.post("/auth/login", data={"username": username, "password": PASSWORD})
    assert logged_in.status_code == 204, logged_in.text


def tagging_jobs(connector: InMemoryConnector) -> list[dict[str, Any]]:
    return [job for job in connector.jobs.values() if job["task_name"] == "tagging.run_tagging"]


async def set_tag_status(engine: AsyncEngine, job_id: uuid.UUID, status: str) -> None:
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "UPDATE iclip.library_entries SET tag_status = :status"
                " WHERE kind = 'hit_case' AND job_id = :id"
            ),
            {"status": status, "id": job_id},
        )


async def hit_case_count(client: httpx.AsyncClient, *path: str) -> int:
    node: dict[str, Any] = {"children": (await client.get("/library-tags")).json()["dimensions"]}
    for name in path:
        (node,) = [one for one in node["children"] if one["name"] == name]
    return int(node["counts"]["hitCases"])


async def test_anonymous_is_401(http: httpx.AsyncClient) -> None:
    job = uuid.uuid4()
    assert (await http.get(HIT_CASES)).status_code == 401
    assert (await http.get(f"{HIT_CASES}/{job}")).status_code == 401
    assert (await http.put(f"{HIT_CASES}/{job}", json={})).status_code == 401
    assert (await http.delete(f"{HIT_CASES}/{job}")).status_code == 401


async def test_ineligible_materials_are_422_with_their_reason(
    http: httpx.AsyncClient, pg_url: str, engine: AsyncEngine
) -> None:
    """图片不是素材片；不挂对话的出片没有对话；对话里没有新片执行方案。不存在的视频是 404。"""

    await login_as(http, pg_url, "maya", "editor")
    nora = await plant_named_user(engine, "nora")
    conversation = await plant_conversation(engine, nora)
    image = await plant_job(engine, nora, conversation, kind="image")
    detached = await plant_job(engine, nora, None)
    no_treatment = await plant_job(engine, nora, conversation)

    for job_id, reason, message in (
        (image, "not_material", "不是成片素材里的素材片"),
        (detached, "no_conversation", "不在任何对话里"),
        (no_treatment, "no_treatment", "所在对话没有新片执行方案"),
    ):
        state = await http.get(f"{HIT_CASES}/{job_id}")
        added = await http.put(f"{HIT_CASES}/{job_id}", json={"tagIds": []})

        assert state.status_code == 200, state.text
        assert state.json() == {
            "jobId": str(job_id),
            "eligible": False,
            "ineligibleReason": reason,
            "entry": None,
        }
        assert added.status_code == 422, added.text
        assert message in added.text
        assert await hit_case_rows(engine, job_id) == (0, 0)

    missing = uuid.uuid4()
    assert (await http.get(f"{HIT_CASES}/{missing}")).status_code == 404
    assert (await http.put(f"{HIT_CASES}/{missing}", json={})).status_code == 404


async def test_a_deleted_conversation_still_counts(
    http: httpx.AsyncClient, pg_url: str, engine: AsyncEngine
) -> None:
    await login_as(http, pg_url, "maya", "editor")
    nora = await plant_named_user(engine, "nora")
    conversation, job_id = await plant_material(engine, nora)
    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE iclip.conversations SET deleted_at = now() WHERE id = :id"),
            {"id": conversation},
        )

    state = await http.get(f"{HIT_CASES}/{job_id}")

    assert (state.json()["eligible"], state.json()["ineligibleReason"]) == (True, None)


async def test_adding_keeps_manual_tags_queues_once_and_is_idempotent(
    http: httpx.AsyncClient, pg_url: str, engine: AsyncEngine, connector: InMemoryConnector
) -> None:
    """别人对话里的素材片也能加；再加一次原样交回，带来的不同标签不写、也不再排打标。"""

    await login_as(http, pg_url, "maya", "editor")
    nora = await plant_named_user(engine, "nora")
    _, job_id = await plant_material(engine, nora)
    amz = await tag_id(engine, "平台&渠道", "AMZ")
    dtc = await tag_id(engine, "平台&渠道", "DTC")

    first = await http.put(f"{HIT_CASES}/{job_id}", json={"tagIds": [str(amz), str(amz)]})
    again = await http.put(f"{HIT_CASES}/{job_id}", json={"tagIds": [str(dtc)]})

    assert first.status_code == 200, first.text
    entry = first.json()["entry"]
    assert first.json()["eligible"] is True
    assert (entry["tagIds"], entry["tagStatus"], entry["tagError"], entry["addedBy"]) == (
        [str(amz)],
        "pending",
        None,
        "maya",
    )
    assert again.status_code == 200, again.text
    assert again.json() == first.json()
    assert len(tagging_jobs(connector)) == 1


async def test_tags_that_are_not_values_are_422_and_nothing_is_added(
    http: httpx.AsyncClient, pg_url: str, engine: AsyncEngine, connector: InMemoryConnector
) -> None:
    await login_as(http, pg_url, "maya", "editor")
    nora = await plant_named_user(engine, "nora")
    _, job_id = await plant_material(engine, nora)
    dimension = await tag_id(engine, "平台&渠道")

    added = await http.put(f"{HIT_CASES}/{job_id}", json={"tagIds": [str(dimension)]})

    assert added.status_code == 422, added.text
    assert await hit_case_rows(engine, job_id) == (0, 0)
    assert tagging_jobs(connector) == []


async def test_tags_and_retagging_need_an_entry_that_is_not_being_tagged(
    http: httpx.AsyncClient, pg_url: str, engine: AsyncEngine, connector: InMemoryConnector
) -> None:
    await login_as(http, pg_url, "maya", "editor")
    nora = await plant_named_user(engine, "nora")
    _, job_id = await plant_material(engine, nora)
    amz = await tag_id(engine, "平台&渠道", "AMZ")
    path = f"{HIT_CASES}/{job_id}"

    assert (await http.put(f"{path}/tags", json={"tagIds": []})).status_code == 404
    assert (await http.post(f"{path}/tagging")).status_code == 404
    assert (await http.get(path)).json()["entry"] is None

    await http.put(path, json={})
    busy_tags = await http.put(f"{path}/tags", json={"tagIds": [str(amz)]})
    busy_retag = await http.post(f"{path}/tagging")
    await set_tag_status(engine, job_id, "completed")
    replaced = await http.put(f"{path}/tags", json={"tagIds": [str(amz)]})
    retagged = await http.post(f"{path}/tagging")

    assert (busy_tags.status_code, busy_retag.status_code) == (409, 409)
    assert replaced.status_code == 200, replaced.text
    assert replaced.json()["entry"]["tagIds"] == [str(amz)]
    assert retagged.status_code == 200, retagged.text
    assert retagged.json()["entry"]["tagStatus"] == "pending"
    assert len(tagging_jobs(connector)) == 2


async def test_retagging_needs_generation_submit(
    http: httpx.AsyncClient, pg_url: str, engine: AsyncEngine
) -> None:
    """看得见就能入选、改标签、移出；重新打标是付费调用，另要 ``generation:submit``。"""

    await login_as(http, pg_url, "vera", "viewer")
    nora = await plant_named_user(engine, "nora")
    _, job_id = await plant_material(engine, nora)

    added = await http.put(f"{HIT_CASES}/{job_id}", json={})
    await set_tag_status(engine, job_id, "completed")

    assert added.status_code == 200, added.text
    assert (await http.post(f"{HIT_CASES}/{job_id}/tagging")).status_code == 403


async def test_removing_deletes_the_entry_with_its_tags_and_is_idempotent(
    http: httpx.AsyncClient, pg_url: str, engine: AsyncEngine
) -> None:
    await login_as(http, pg_url, "maya", "editor")
    nora = await plant_named_user(engine, "nora")
    _, job_id = await plant_material(engine, nora)
    amz = await tag_id(engine, "平台&渠道", "AMZ")
    await http.put(f"{HIT_CASES}/{job_id}", json={"tagIds": [str(amz)]})
    assert await hit_case_rows(engine, job_id) == (1, 1)
    assert await hit_case_count(http, "平台&渠道", "AMZ") == 1

    removed = await http.delete(f"{HIT_CASES}/{job_id}")
    again = await http.delete(f"{HIT_CASES}/{job_id}")

    assert (removed.status_code, again.status_code) == (204, 204)
    assert await hit_case_rows(engine, job_id) == (0, 0)
    assert (await http.get(f"{HIT_CASES}/{job_id}")).json()["entry"] is None
    assert (await http.get(HIT_CASES)).json()["items"] == []
    assert await hit_case_count(http, "平台&渠道", "AMZ") == 0


async def test_the_list_filters_by_tags_and_pages_by_when_they_were_added(
    http: httpx.AsyncClient, pg_url: str, engine: AsyncEngine
) -> None:
    """同一维度命中任一、维度之间都要命中、选大类也算小类；不再是素材片的不列；不存在的标签是 422。"""

    await login_as(http, pg_url, "maya", "editor")
    nora = await plant_named_user(engine, "nora")
    amz = await tag_id(engine, "平台&渠道", "AMZ")
    dtc = await tag_id(engine, "平台&渠道", "DTC")
    tiktok = await tag_id(engine, "平台&渠道", "TikTok")
    review = await tag_id(engine, "内容结构", "开箱测评型")
    compare = await tag_id(engine, "内容结构", "开箱测评型", "对比测评")
    slipper = await tag_id(engine, "品类", "拖鞋")
    conversation_a, a = await plant_material(engine, nora)
    _, b = await plant_material(engine, nora)
    _, c = await plant_material(engine, nora)
    failed = await plant_job(engine, nora, conversation_a, status="failed")
    await plant_hit_case(engine, a, tags=[amz, compare], added_minutes_ago=1)
    await plant_hit_case(engine, b, tags=[dtc, review], added_minutes_ago=2)
    await plant_hit_case(engine, c, tags=[tiktok, slipper], added_minutes_ago=3)
    await plant_hit_case(engine, failed, tags=[amz], added_minutes_ago=0)

    async def listed(*tags: uuid.UUID) -> list[str]:
        response = await http.get(HIT_CASES, params={"tags": [str(one) for one in tags]})
        assert response.status_code == 200, response.text
        return [item["jobId"] for item in response.json()["items"]]

    everything = (await http.get(HIT_CASES)).json()
    first = everything["items"][0]
    assert [item["jobId"] for item in everything["items"]] == [str(a), str(b), str(c)]
    assert everything["total"] == 3
    assert (first["cardId"], first["title"], first["face"]["jobId"], first["take"]["id"]) == (
        str(conversation_a),
        "凉鞋合集",
        str(a),
        str(a),
    )
    assert (first["tagStatus"], set(first["tagIds"])) == ("completed", {str(amz), str(compare)})
    assert await listed(amz, dtc) == [str(a), str(b)]
    assert await listed(amz, review) == [str(a)]
    assert await listed(review) == [str(a), str(b)]
    bad = await http.get(HIT_CASES, params={"tags": [str(uuid.uuid4())]})
    assert bad.status_code == 422

    page_one = (await http.get(HIT_CASES, params={"limit": 2})).json()
    page_two = (
        await http.get(HIT_CASES, params={"limit": 2, "cursor": page_one["nextCursor"]})
    ).json()
    assert [item["jobId"] for item in page_one["items"]] == [str(a), str(b)]
    assert [item["jobId"] for item in page_two["items"]] == [str(c)]
    assert (page_two["total"], page_two["nextCursor"]) == (None, None)


async def test_the_card_id_opens_the_card_holding_that_version(
    http: httpx.AsyncClient, pg_url: str, engine: AsyncEngine
) -> None:
    """卡 id 就是素材片所在对话；那段对话的素材卡详情里能找到这一版。"""

    await login_as(http, pg_url, "maya", "editor")
    nora = await plant_named_user(engine, "nora")
    conversation, job_id = await plant_material(engine, nora)
    await http.put(f"{HIT_CASES}/{job_id}", json={})

    card_id = (await http.get(HIT_CASES)).json()["items"][0]["cardId"]
    detail = (await http.get(f"/library/videos/{card_id}")).json()

    assert card_id == str(conversation)
    assert str(job_id) in [
        version["jobId"] for group in detail["groups"] for version in group["versions"]
    ]


async def test_without_tagging_configured_adding_works_but_nothing_is_tagged(
    client: httpx.AsyncClient, pg_url: str, engine: AsyncEngine
) -> None:
    await login_as(client, pg_url, "maya", "editor")
    nora = await plant_named_user(engine, "nora")
    _, job_id = await plant_material(engine, nora)
    amz = await tag_id(engine, "平台&渠道", "AMZ")

    added = await client.put(f"{HIT_CASES}/{job_id}", json={"tagIds": [str(amz)]})
    retag = await client.post(f"{HIT_CASES}/{job_id}/tagging")

    assert added.status_code == 200, added.text
    assert (added.json()["entry"]["tagStatus"], added.json()["entry"]["tagIds"]) == (
        None,
        [str(amz)],
    )
    assert retag.status_code == 404
