"""参考视频端点：端点权限、只收本人的视频上传、属主检查与状态码；拆解没配置时只挂读端点，上传不可用时不挂建行。

拆解与打标是替身，队列连接器是内存替身（不跑 lifespan，排进去的任务不执行）。"""

from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator

import httpx
import pytest
from fastapi import FastAPI
from procrastinate.testing import InMemoryConnector
from sqlalchemy.ext.asyncio import create_async_engine

from iclip.app.bootstrap import build_app
from tests.helpers.app import make_client, make_runtime_config
from tests.helpers.auth import register_and_login, set_roles_in_db
from tests.helpers.generation import MemoryObjectStore
from tests.helpers.pg import reset_database
from tests.helpers.references import (
    STUDIO_ENVS,
    FakeArk,
    ark_pipeline,
    config_with_studio,
    plant_reference,
    upload_video,
)

PASSWORD = "password-123"


@pytest.fixture
def bucket() -> MemoryObjectStore:
    return MemoryObjectStore()


@pytest.fixture
async def studio_app(
    base_env: None, migrated_pg: str, monkeypatch: pytest.MonkeyPatch, bucket: MemoryObjectStore
) -> AsyncGenerator[FastAPI]:
    """拆解配好、媒体生成没开的 app。"""

    for name, value in STUDIO_ENVS.items():
        monkeypatch.setenv(name, value)
    monkeypatch.delenv("VIDEO_SUBMIT_URL", raising=False)
    engine = create_async_engine(migrated_pg)
    async with engine.begin() as conn:
        await reset_database(conn)
    breakdowns, tagger = ark_pipeline(FakeArk())
    try:
        yield build_app(
            config_with_studio(),
            engine=engine,
            object_store=bucket,
            queue_connector=InMemoryConnector(),
            reference_breakdowns=breakdowns,
            reference_tagger=tagger,
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


async def test_anonymous_is_401(http: httpx.AsyncClient) -> None:
    for path in ("/references", "/references/filters", f"/references/{uuid.uuid4()}"):
        assert (await http.get(path)).status_code == 401


async def test_an_own_video_upload_becomes_one_reference(
    http: httpx.AsyncClient, pg_url: str, bucket: MemoryObjectStore
) -> None:
    await login_as(http, pg_url, "maya", "editor")
    upload_id = await upload_video(http, bucket)

    created = await http.post("/references", json={"uploadId": upload_id})
    again = await http.post("/references", json={"uploadId": upload_id})
    listed = await http.get("/references")

    assert created.status_code == 201, created.text
    assert again.status_code == 200, again.text
    body = created.json()
    assert again.json()["id"] == body["id"]
    assert body["breakdownStatus"] == "pending"
    assert (body["userName"], body["canEdit"], body["document"]) == ("maya", True, None)
    page = listed.json()
    assert (page["total"], page["canUpload"]) == (1, True)
    assert [item["id"] for item in page["items"]] == [body["id"]]
    assert "document" not in page["items"][0]


async def test_someone_elses_or_a_non_video_upload_is_404(
    http: httpx.AsyncClient, pg_url: str, bucket: MemoryObjectStore
) -> None:
    await login_as(http, pg_url, "maya", "editor")
    mayas = await upload_video(http, bucket)
    signed = await http.post(
        "/uploads/sign", json={"contentType": "image/png", "width": 800, "height": 800}
    )
    image_id = signed.json()["uploadId"]
    await bucket.put_public_object(
        object_key=f"iclip/agent/uploads/{image_id}.png", content=b"x", content_type="image/png"
    )
    assert (await http.post(f"/uploads/{image_id}/confirm")).status_code == 200

    image = await http.post("/references", json={"uploadId": image_id})
    missing = await http.post("/references", json={"uploadId": str(uuid.uuid4())})
    await login_as(http, pg_url, "sara", "editor")
    others = await http.post("/references", json={"uploadId": mayas})

    assert (image.status_code, missing.status_code, others.status_code) == (404, 404, 404)


async def test_only_the_owner_edits_and_removes(
    http: httpx.AsyncClient, pg_url: str, bucket: MemoryObjectStore
) -> None:
    await login_as(http, pg_url, "maya", "editor")
    upload_id = await upload_video(http, bucket)
    reference = (await http.post("/references", json={"uploadId": upload_id})).json()
    path = f"/references/{reference['id']}"
    edit = {"version": 1, "document": "改过", "videoTypes": ["review"], "categories": ["跑鞋"]}

    await login_as(http, pg_url, "sara", "editor")
    seen = await http.get(path)
    assert (seen.status_code, seen.json()["canEdit"]) == (200, False)
    assert (await http.patch(path, json=edit)).status_code == 403
    assert (await http.delete(path)).status_code == 403
    assert (await http.post(f"{path}/breakdowns")).status_code == 403

    await login_as(http, pg_url, "maya", "editor")
    # 还在排队：改与重拆都撞上拆解中。
    assert (await http.patch(path, json=edit)).status_code == 409
    assert (await http.post(f"{path}/breakdowns")).status_code == 409
    assert (await http.delete(path)).status_code == 204
    assert (await http.get(path)).status_code == 404
    assert (await http.get("/references")).json()["items"] == []


async def test_edit_takes_only_listed_tags(
    http: httpx.AsyncClient, pg_url: str, bucket: MemoryObjectStore
) -> None:
    await login_as(http, pg_url, "maya", "editor")
    upload_id = await upload_video(http, bucket)
    reference = (await http.post("/references", json={"uploadId": upload_id})).json()

    response = await http.patch(
        f"/references/{reference['id']}",
        json={"version": 1, "document": "x", "videoTypes": ["vlog"], "categories": []},
    )

    assert response.status_code == 422


async def test_a_viewer_reads_but_cannot_upload_or_rerun(
    http: httpx.AsyncClient, pg_url: str, bucket: MemoryObjectStore
) -> None:
    await login_as(http, pg_url, "maya", "editor")
    upload_id = await upload_video(http, bucket)
    reference = (await http.post("/references", json={"uploadId": upload_id})).json()

    await login_as(http, pg_url, "vera", "viewer")
    listed = await http.get("/references")
    filters = await http.get("/references/filters")
    rerun = await http.post(f"/references/{reference['id']}/breakdowns")

    assert (listed.status_code, listed.json()["canUpload"]) == (200, False)
    assert filters.status_code == 200
    assert len(filters.json()["videoTypes"]) == 8
    assert rerun.status_code == 403


async def test_without_an_object_store_uploads_are_off_but_reruns_still_work(
    base_env: None, migrated_pg: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """拆解配好、对象存储没配：上传模块不装配，资料库不收上传；重拆不需要对象存储。"""

    for name, value in STUDIO_ENVS.items():
        if not name.startswith("OSS_"):
            monkeypatch.setenv(name, value)
    monkeypatch.delenv("VIDEO_SUBMIT_URL", raising=False)
    engine = create_async_engine(migrated_pg)
    async with engine.begin() as conn:
        await reset_database(conn)
    breakdowns, tagger = ark_pipeline(FakeArk())
    try:
        app = build_app(
            config_with_studio(),
            engine=engine,
            queue_connector=InMemoryConnector(),
            reference_breakdowns=breakdowns,
            reference_tagger=tagger,
        )
        async with make_client(app) as client:
            await login_as(client, migrated_pg, "maya", "editor")
            maya = uuid.UUID((await client.get("/users/me")).json()["user"]["id"])
            reference_id = await plant_reference(
                engine, owner=maya, status="failed", error_code="model_call_failed"
            )
            listed = await client.get("/references")
            created = await client.post("/references", json={"uploadId": str(uuid.uuid4())})
            rerun = await client.post(f"/references/{reference_id}/breakdowns")
    finally:
        await engine.dispose()

    assert (listed.status_code, listed.json()["canUpload"]) == (200, False)
    assert created.status_code == 405
    assert rerun.status_code == 200, rerun.text
    assert rerun.json()["breakdownStatus"] == "pending"


async def test_without_breakdown_configured_only_reads_are_mounted(
    base_env: None, migrated_pg: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("VIDEO_UNDERSTANDING_URL", raising=False)
    engine = create_async_engine(migrated_pg)
    async with engine.begin() as conn:
        await reset_database(conn)
    try:
        app = build_app(make_runtime_config(), engine=engine)
        async with make_client(app) as client:
            await register_and_login(client, username="maya", email="maya@example.com")
            await set_roles_in_db(migrated_pg, "maya@example.com", ["editor"])
            listed = await client.get("/references")
            created = await client.post("/references", json={"uploadId": str(uuid.uuid4())})
            rerun = await client.post(f"/references/{uuid.uuid4()}/breakdowns")
    finally:
        await engine.dispose()

    assert (listed.status_code, listed.json()["canUpload"]) == (200, False)
    assert created.status_code == 405
    assert rerun.status_code == 404
