"""参考视频试生成端点：只限属主本人、什么时候 409 与 422、落成一条什么样的视频生成，以及详情里的
``testVideo`` 怎么跟着生成记录与当前拆解变。

拆解配好、媒体生成开着；队列连接器是内存替身，不跑 worker，生成记录的状态直接改表模拟。"""

from __future__ import annotations

import json
import uuid
from collections.abc import AsyncGenerator
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from procrastinate.testing import InMemoryConnector
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from iclip.app.bootstrap import build_app
from iclip.domains.references.test_prompt import build_test_prompt
from iclip.platform.media.codec import SOFTWARE
from tests.helpers.app import make_client
from tests.helpers.auth import set_roles_in_db
from tests.helpers.generation import MemoryObjectStore
from tests.helpers.pg import connected, reset_database
from tests.helpers.references import (
    DOCUMENT,
    STUDIO_MEDIA_ENVS,
    FakeArk,
    ark_pipeline,
    config_with_studio_and_media,
    plant_reference,
)

PASSWORD = "password-123"

FULL = """\
# 出场元素

| 类型 | 名字 | 辨识特征 | 首次出现 |
| :--- | :--- | :--- | :--- |
| 人物 | 金色短发女生 | 二十岁出头的白人女性。 | 0.0 |
| 产品 | 厚底毛口拖鞋 | 一双浅卡其色麂皮厚底拖鞋。 | 0.0 |

# 时间线

## 0.0-6.2 · 场景引入

### 镜 01 · 0.0-2.4

**镜头语言**：开场，手持，平视全景
**画面**：金色短发女生站在涂鸦墙前。
**BGM**：无
**音效**：1.2 滑板落地声
**包装**：无
**关键帧**：0.4

### 镜 02 · 2.4-6.2

**镜头语言**：硬切，低机位，脚部特写
**画面**：她的右脚踩上滑板。
**BGM**：无
**音效**：无
**包装**：无
**关键帧**：3.0

# 整片分析

## 想达到什么
记住这双拖鞋。
"""
"""一份拼得出提示词的拆解：两镜，最后一镜止于 6.2 秒。"""


@pytest.fixture
async def media_app(
    base_env: None, migrated_pg: str, monkeypatch: pytest.MonkeyPatch
) -> AsyncGenerator[FastAPI]:
    for name, value in STUDIO_MEDIA_ENVS.items():
        monkeypatch.setenv(name, value)
    engine = create_async_engine(migrated_pg)
    async with engine.begin() as conn:
        await reset_database(conn)
    breakdowns, tagger = ark_pipeline(FakeArk())
    try:
        yield build_app(
            config_with_studio_and_media(),
            engine=engine,
            object_store=MemoryObjectStore(),
            queue_connector=InMemoryConnector(),
            reference_breakdowns=breakdowns,
            reference_tagger=tagger,
            media_codec=SOFTWARE,
        )
    finally:
        await engine.dispose()


@pytest.fixture
async def http(media_app: FastAPI) -> AsyncGenerator[httpx.AsyncClient]:
    async with make_client(media_app) as client:
        yield client


async def login_as(client: httpx.AsyncClient, pg_url: str, username: str, role: str) -> uuid.UUID:
    """第一次叫到这个名字就注册，之后只是重新登录；交回用户 id。"""

    email = f"{username}@example.com"
    created = await client.post(
        "/auth/register", json={"email": email, "password": PASSWORD, "username": username}
    )
    if created.status_code == 201:
        await set_roles_in_db(pg_url, email, [role])
    logged_in = await client.post("/auth/login", data={"username": username, "password": PASSWORD})
    assert logged_in.status_code == 204, logged_in.text
    return uuid.UUID((await client.get("/users/me")).json()["user"]["id"])


async def trial_jobs(pg_url: str, reference_id: uuid.UUID) -> list[dict[str, Any]]:
    async with connected(pg_url) as conn:
        rows = await conn.execute(
            text(
                "SELECT owner_user_id, kind, operation, status, request, metadata,"
                " conversation_id, shot_index FROM iclip.generation_jobs"
                " WHERE metadata @> CAST(:tag AS jsonb) ORDER BY created_at"
            ),
            {"tag": json.dumps({"referenceId": str(reference_id)})},
        )
        return [dict(row) for row in rows.mappings()]


async def settle(pg_url: str, reference_id: uuid.UUID, **columns: str) -> None:
    """把这条参考视频的试生成改成给定的状态与结果。"""

    assignments = ", ".join(f"{name} = :{name}" for name in columns)
    async with connected(pg_url) as conn:
        await conn.execute(
            text(
                f"UPDATE iclip.generation_jobs SET {assignments}, finished_at = now()"
                " WHERE metadata @> CAST(:tag AS jsonb)"
            ),
            {**columns, "tag": json.dumps({"referenceId": str(reference_id)})},
        )


def path(reference_id: uuid.UUID) -> str:
    return f"/references/{reference_id}/test-generations"


async def test_the_owner_submits_one_wan3_video_from_the_breakdown(
    http: httpx.AsyncClient, pg_url: str, engine: AsyncEngine
) -> None:
    maya = await login_as(http, pg_url, "maya", "editor")
    reference_id = await plant_reference(engine, owner=maya, document=FULL)

    response = await http.post(path(reference_id), json={"aspectRatio": "9:16"})

    assert response.status_code == 200, response.text
    test_video = response.json()["testVideo"]
    assert test_video["status"] == "running"
    assert (test_video["url"], test_video["errorMessage"], test_video["stale"]) == (
        None,
        None,
        False,
    )
    (job,) = await trial_jobs(pg_url, reference_id)
    assert (job["owner_user_id"], job["kind"], job["operation"], job["status"]) == (
        maya,
        "video",
        "generate",
        "pending",
    )
    assert (job["conversation_id"], job["shot_index"]) == (None, None)
    assert job["metadata"] == {"referenceId": str(reference_id)}
    request = job["request"]
    assert request["model"] == "wan3.0-video-prime"
    assert request["resolution"] == "480p"
    assert request["seconds"] == 7
    assert request["aspect_ratio"] == "9:16"
    assert request["generate_audio"] is True
    assert request["prompt"] == build_test_prompt(FULL).text
    assert request["user_name"] == "maya"


async def test_only_the_owner_themself_may_submit(
    http: httpx.AsyncClient, pg_url: str, engine: AsyncEngine
) -> None:
    """别人看得见也不行，能改别人参考视频的治理者也不行。"""

    maya = await login_as(http, pg_url, "maya", "editor")
    reference_id = await plant_reference(engine, owner=maya, document=FULL)

    await login_as(http, pg_url, "sara", "editor")
    by_editor = await http.post(path(reference_id), json={"aspectRatio": "9:16"})
    await login_as(http, pg_url, "root", "root")
    by_root = await http.post(path(reference_id), json={"aspectRatio": "9:16"})
    await login_as(http, pg_url, "vera", "viewer")
    by_viewer = await http.post(path(reference_id), json={"aspectRatio": "9:16"})

    assert (by_editor.status_code, by_root.status_code, by_viewer.status_code) == (403, 403, 403)
    assert await trial_jobs(pg_url, reference_id) == []


async def test_an_unfinished_breakdown_is_409(
    http: httpx.AsyncClient, pg_url: str, engine: AsyncEngine
) -> None:
    maya = await login_as(http, pg_url, "maya", "editor")
    queued = await plant_reference(engine, owner=maya, status="pending", document=None)
    rerunning = await plant_reference(
        engine, owner=maya, video_url="https://cdn.example.test/b.mp4", status="running"
    )
    never_done = await plant_reference(
        engine,
        owner=maya,
        video_url="https://cdn.example.test/c.mp4",
        status="failed",
        document=None,
        error_code="model_failed",
    )

    statuses = [
        (await http.post(path(one), json={"aspectRatio": "9:16"})).status_code
        for one in (queued, rerunning, never_done)
    ]

    assert statuses == [409, 409, 409]


async def test_one_test_video_at_a_time(
    http: httpx.AsyncClient, pg_url: str, engine: AsyncEngine
) -> None:
    maya = await login_as(http, pg_url, "maya", "editor")
    reference_id = await plant_reference(engine, owner=maya, document=FULL)

    first = await http.post(path(reference_id), json={"aspectRatio": "9:16"})
    await settle(pg_url, reference_id, status="submitted")
    while_waiting = await http.post(path(reference_id), json={"aspectRatio": "16:9"})
    await settle(pg_url, reference_id, status="failed", error_message="upstream said no")
    after_failing = await http.post(path(reference_id), json={"aspectRatio": "16:9"})

    assert (first.status_code, while_waiting.status_code) == (200, 409)
    assert after_failing.status_code == 200, after_failing.text
    assert after_failing.json()["testVideo"]["status"] == "running"
    jobs = await trial_jobs(pg_url, reference_id)
    assert [job["request"]["aspect_ratio"] for job in jobs] == ["9:16", "16:9"]


async def test_a_breakdown_that_cannot_make_a_prompt_is_422(
    http: httpx.AsyncClient, pg_url: str, engine: AsyncEngine
) -> None:
    maya = await login_as(http, pg_url, "maya", "editor")
    incomplete = await plant_reference(engine, owner=maya, document=DOCUMENT)
    too_long = await plant_reference(
        engine,
        owner=maya,
        video_url="https://cdn.example.test/long.mp4",
        document=FULL.replace("二十岁出头的白人女性。", "很长的描述。" * 700),
    )

    responses = [
        await http.post(path(one), json={"aspectRatio": "9:16"}) for one in (incomplete, too_long)
    ]

    assert [one.status_code for one in responses] == [422, 422]
    assert await trial_jobs(pg_url, incomplete) == []
    assert await trial_jobs(pg_url, too_long) == []


async def test_the_detail_follows_the_generation_record(
    http: httpx.AsyncClient, pg_url: str, engine: AsyncEngine
) -> None:
    """所有读者看到的都是属主名下最新的那一条。"""

    maya = await login_as(http, pg_url, "maya", "editor")
    reference_id = await plant_reference(engine, owner=maya, document=FULL)
    before = (await http.get(f"/references/{reference_id}")).json()
    assert before["testVideo"] is None
    await http.post(path(reference_id), json={"aspectRatio": "9:16"})

    await settle(
        pg_url, reference_id, status="completed", output_url="https://cdn.example.test/t.mp4"
    )
    await login_as(http, pg_url, "sara", "editor")
    completed = (await http.get(f"/references/{reference_id}")).json()["testVideo"]
    await settle(pg_url, reference_id, status="failed", error_message="upstream said no")
    failed = (await http.get(f"/references/{reference_id}")).json()["testVideo"]

    assert (completed["status"], completed["url"], completed["stale"]) == (
        "completed",
        "https://cdn.example.test/t.mp4",
        False,
    )
    assert (failed["status"], failed["errorMessage"]) == ("failed", "upstream said no")


async def test_stale_follows_the_prompt_the_breakdown_makes(
    http: httpx.AsyncClient, pg_url: str, engine: AsyncEngine
) -> None:
    maya = await login_as(http, pg_url, "maya", "editor")
    reference_id = await plant_reference(engine, owner=maya, document=FULL)
    await http.post(path(reference_id), json={"aspectRatio": "9:16"})
    await settle(pg_url, reference_id, status="completed", output_url="https://cdn.test/t.mp4")
    detail = f"/references/{reference_id}"

    current = (await http.get(detail)).json()
    tags_only = await http.patch(
        detail,
        json={
            "version": current["version"],
            "document": current["document"],
            "videoTypes": ["lifestyle"],
            "categories": ["拖鞋"],
        },
    )
    edited = await http.patch(
        detail,
        json={
            "version": tags_only.json()["version"],
            "document": FULL.replace("她的右脚踩上滑板。", "她的左脚踩上滑板。"),
            "videoTypes": ["lifestyle"],
            "categories": ["拖鞋"],
        },
    )

    assert tags_only.status_code == 200, tags_only.text
    assert tags_only.json()["testVideo"]["stale"] is False
    assert edited.status_code == 200, edited.text
    assert edited.json()["testVideo"]["stale"] is True
