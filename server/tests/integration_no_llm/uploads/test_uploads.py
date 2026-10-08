"""验证直传链路：签名带审计头、确认只按桶里的对象回答并落一条上传记录（媒体生成没开也落）、
角色门与没桶时不挂路由。"""

from __future__ import annotations

import hashlib
import uuid
from collections.abc import AsyncGenerator

import httpx
import pytest
from fastapi import FastAPI
from procrastinate.testing import InMemoryConnector
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from iclip.app.bootstrap import build_app
from iclip.domains.generation.infra_sql import SqlGenerationRepository
from iclip.domains.generation.models import GenerationJob
from tests.helpers.app import make_client, make_runtime_config
from tests.helpers.auth import login_as_editor, register_and_login, set_roles_in_db
from tests.helpers.generation import MEDIA_ENVS, MemoryObjectStore, config_with_media
from tests.helpers.pg import connected, reset_database

OSS_ENVS = {
    "OSS_BUCKET": "iclip-test",
    "OSS_ENDPOINT": "oss-ap-southeast-1.aliyuncs.com",
    "OSS_ACCESS_KEY_ID": "ak",
    "OSS_ACCESS_KEY_SECRET": "sk",
    "OSS_PUBLIC_URL_BASE": "https://cdn.example.test",
}


@pytest.fixture
def bucket() -> MemoryObjectStore:
    return MemoryObjectStore()


@pytest.fixture
async def uploads_app(
    base_env: None,
    migrated_pg: str,
    monkeypatch: pytest.MonkeyPatch,
    bucket: MemoryObjectStore,
) -> AsyncGenerator[FastAPI]:
    """真实数据库配合 bucket 替身，隔离 OSS 凭证。"""

    for name, value in OSS_ENVS.items():
        monkeypatch.setenv(name, value)
    engine = create_async_engine(migrated_pg)
    async with engine.begin() as conn:
        await reset_database(conn)
    try:
        yield build_app(make_runtime_config(), engine=engine, object_store=bucket)
    finally:
        await engine.dispose()


@pytest.fixture
async def client(uploads_app: FastAPI) -> AsyncGenerator[httpx.AsyncClient]:
    async with make_client(uploads_app) as c:
        yield c


async def sign(client: httpx.AsyncClient, content_type: str) -> httpx.Response:
    return await client.post(
        "/uploads/sign", json={"contentType": content_type, "width": 1200, "height": 1600}
    )


async def test_upload_round_trip_hands_back_the_public_url(
    client: httpx.AsyncClient, pg_url: str, bucket: MemoryObjectStore
) -> None:
    user_id = await login_as_editor(client, pg_url)

    signed = await sign(client, "video/mp4")
    assert signed.status_code == 200, signed.text
    ticket = signed.json()
    upload_id = ticket["uploadId"]
    assert ticket["upload"]["headers"] == {
        "Content-Type": "video/mp4",
        "x-oss-meta-uploader": user_id,
    }
    await bucket.put_public_object(
        object_key=f"iclip/agent/uploads/{upload_id}.mp4",
        content=b"MP4DATA" * 10,
        content_type="video/mp4",
    )

    confirmed = await client.post(f"/uploads/{upload_id}/confirm")

    assert confirmed.status_code == 200, confirmed.text
    assert confirmed.json() == {
        "url": f"https://cdn.example.test/iclip/agent/uploads/{upload_id}.mp4",
        "contentType": "video/mp4",
        "sizeBytes": 70,
    }
    again = await client.post(f"/uploads/{upload_id}/confirm")
    assert again.json() == confirmed.json()


async def test_confirming_something_nobody_uploaded_is_a_conflict(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    await login_as_editor(client, pg_url)

    assert (await client.post(f"/uploads/{uuid.uuid4()}/confirm")).status_code == 409
    assert await upload_rows(pg_url) == 0, "核对不过不落记录"


async def uploaded(
    client: httpx.AsyncClient, bucket: MemoryObjectStore, content_type: str, ext: str
) -> tuple[str, str]:
    """签一次、把字节放进桶；返回 uploadId 与对象 key。"""

    upload_id = (await sign(client, content_type)).json()["uploadId"]
    key = f"iclip/agent/uploads/{upload_id}.{ext}"
    await bucket.put_public_object(object_key=key, content=b"x" * 10, content_type=content_type)
    return upload_id, key


async def stored(pg_url: str, upload_id: str) -> GenerationJob:
    engine = create_async_engine(pg_url)
    try:
        return await SqlGenerationRepository(engine).get(uuid.UUID(upload_id), owner=None)
    finally:
        await engine.dispose()


async def upload_rows(pg_url: str) -> int:
    async with connected(pg_url) as conn:
        found = await conn.execute(
            text("SELECT count(*) FROM iclip.generation_jobs WHERE operation = 'upload'")
        )
        return int(found.scalar_one())


@pytest.mark.parametrize(
    ("content_type", "ext", "kind"), [("image/png", "png", "image"), ("video/mp4", "mp4", "video")]
)
async def test_confirming_records_an_upload_even_without_media_generation(
    client: httpx.AsyncClient,
    pg_url: str,
    bucket: MemoryObjectStore,
    content_type: str,
    ext: str,
    kind: str,
) -> None:
    """只开对象存储、没开媒体生成：确认照样落一条上传记录，id 就是 uploadId，创建即完成、
    没有请求与来源、不挂对话，产物地址就是交回的 url，属主是确认的人。"""

    user_id = await login_as_editor(client, pg_url)
    upload_id, _ = await uploaded(client, bucket, content_type, ext)

    confirmed = await client.post(f"/uploads/{upload_id}/confirm")

    assert confirmed.status_code == 200, confirmed.text
    job = await stored(pg_url, upload_id)
    assert (
        job.kind,
        job.operation,
        job.status,
        job.output_url,
        job.request,
        job.source_job_id,
        job.source_url,
        job.conversation_id,
        job.task_id,
        job.owner_user_id,
        job.api_key_id,
    ) == (
        kind,
        "upload",
        "completed",
        confirmed.json()["url"],
        None,
        None,
        None,
        None,
        None,
        uuid.UUID(user_id),
        None,
    )
    assert job.finished_at is not None


async def test_confirming_again_keeps_the_one_record_and_its_first_owner(
    uploads_app: FastAPI, pg_url: str, bucket: MemoryObjectStore
) -> None:
    """替人办事的钥匙按名字记到那个人名下；再确认一次换了名字也还是那一条、属主不变；桶里的对象
    没了，确认照旧按桶回答 409。"""

    async with make_client(uploads_app) as root:
        await register_and_login(root)
        await set_roles_in_db(pg_url, "logan@example.com", ["root"])
        created = await root.post(
            "/api-keys",
            json={"name": "partner-app", "permissions": ["uploads:write", "users:act_as"]},
        )
        assert created.status_code == 201, created.text
        issued = created.json()["apiKey"]
        async with make_client(uploads_app) as gateway:
            gateway.headers["Authorization"] = f"Bearer {issued['token']}"
            upload_id, key = await uploaded(gateway, bucket, "image/png", "png")
            first = await gateway.post(
                f"/uploads/{upload_id}/confirm", json={"userName": "Sara.Hong"}
            )
            again = await gateway.post(
                f"/uploads/{upload_id}/confirm", json={"userName": "Eva.Lin"}
            )
            del bucket.objects[key]
            gone = await gateway.post(f"/uploads/{upload_id}/confirm")
        users = (await root.get("/users")).json()["items"]

    assert first.status_code == 200, first.text
    assert again.json() == first.json()
    assert gone.status_code == 409
    assert await upload_rows(pg_url) == 1
    job = await stored(pg_url, upload_id)
    sara = next(user["id"] for user in users if user["username"] == "Sara.Hong")
    assert (str(job.owner_user_id), str(job.api_key_id)) == (sara, issued["id"])


async def confirmed_upload(
    http: httpx.AsyncClient,
    bucket: MemoryObjectStore,
    content: bytes,
    content_type: str = "video/mp4",
    ext: str = "mp4",
) -> tuple[str, str, dict[str, object]]:
    """签一次、把 ``content`` 放进桶、确认；返回 uploadId、对象 key 与确认交回的 JSON。"""

    upload_id = (await sign(http, content_type)).json()["uploadId"]
    key = f"iclip/agent/uploads/{upload_id}.{ext}"
    await bucket.put_public_object(object_key=key, content=content, content_type=content_type)
    response = await http.post(f"/uploads/{upload_id}/confirm")
    assert response.status_code == 200, response.text
    return upload_id, key, response.json()


@pytest.mark.parametrize("second_user", ["logan", "sara"], ids=["同一个人", "另一个人"])
async def test_the_same_video_uploaded_again_shares_the_first_address(
    uploads_app: FastAPI, pg_url: str, bucket: MemoryObjectStore, second_user: str
) -> None:
    """同一个视频文件第二次传：交回第一次的地址，两行上传记录都在、各记自己的属主与 MD5，第二份
    对象删掉。再确认第二次那个 uploadId：交回同一份结果，不报还没传上来。"""

    content = b"MP4DATA" * 10
    async with make_client(uploads_app) as first_http, make_client(uploads_app) as second_http:
        first_user_id = await login_as_editor(first_http, pg_url)
        second_user_id = (
            first_user_id
            if second_user == "logan"
            else await login_as_editor(second_http, pg_url, username=second_user)
        )
        second_client = first_http if second_user == "logan" else second_http
        first_id, first_key, first = await confirmed_upload(first_http, bucket, content)
        second_id, second_key, second = await confirmed_upload(second_client, bucket, content)
        again = await second_client.post(f"/uploads/{second_id}/confirm")

    assert first == {
        "url": f"https://cdn.example.test/{first_key}",
        "contentType": "video/mp4",
        "sizeBytes": 70,
    }
    assert second == first
    assert again.status_code == 200, again.text
    assert again.json() == first
    assert (first_key in bucket.objects, second_key in bucket.objects) == (True, False)
    assert await upload_rows(pg_url) == 2
    first_row, second_row = await stored(pg_url, first_id), await stored(pg_url, second_id)
    md5 = hashlib.md5(content).hexdigest()
    assert (first_row.owner_user_id, first_row.output_url, first_row.content_md5) == (
        uuid.UUID(first_user_id),
        first["url"],
        md5,
    )
    assert (second_row.owner_user_id, second_row.output_url, second_row.content_md5) == (
        uuid.UUID(second_user_id),
        first["url"],
        md5,
    )


async def test_the_same_image_uploaded_twice_keeps_two_addresses(
    client: httpx.AsyncClient, pg_url: str, bucket: MemoryObjectStore
) -> None:
    """图片不去重：同样的字节传两次，各留各的地址与对象，不记 MD5。"""

    await login_as_editor(client, pg_url)
    content = b"PNGDATA" * 10
    first_id, first_key, first = await confirmed_upload(client, bucket, content, "image/png", "png")
    second_id, second_key, second = await confirmed_upload(
        client, bucket, content, "image/png", "png"
    )

    assert (first["url"], second["url"]) == (
        f"https://cdn.example.test/{first_key}",
        f"https://cdn.example.test/{second_key}",
    )
    assert (first_key in bucket.objects, second_key in bucket.objects) == (True, True)
    rows = [await stored(pg_url, upload_id) for upload_id in (first_id, second_id)]
    assert [row.content_md5 for row in rows] == [None, None]


@pytest.fixture
async def media_app(
    base_env: None, migrated_pg: str, monkeypatch: pytest.MonkeyPatch, bucket: MemoryObjectStore
) -> AsyncGenerator[FastAPI]:
    """开了媒体生成的 app：队列连接器用替身，生成记录的接口挂得上。"""

    for name, value in MEDIA_ENVS.items():
        monkeypatch.setenv(name, value)
    engine = create_async_engine(migrated_pg)
    async with engine.begin() as conn:
        await reset_database(conn)
    try:
        yield build_app(
            config_with_media(),
            engine=engine,
            object_store=bucket,
            queue_connector=InMemoryConnector(),
        )
    finally:
        await engine.dispose()


async def test_an_upload_reads_back_through_the_generation_records(
    media_app: FastAPI, pg_url: str, bucket: MemoryObjectStore
) -> None:
    """GET /generations/{uploadId} 读得到那条上传；按属主列会看到它，按 operation=generate 筛掉。"""

    async with make_client(media_app) as http:
        await login_as_editor(http, pg_url)
        upload_id, _ = await uploaded(http, bucket, "image/png", "png")
        confirmed = (await http.post(f"/uploads/{upload_id}/confirm")).json()
        record = await http.get(f"/generations/{upload_id}")
        listed = await http.get("/generations")
        generated = await http.get("/generations", params={"operation": "generate"})

    assert record.status_code == 200, record.text
    generation = record.json()["generation"]
    assert (
        generation["kind"],
        generation["operation"],
        generation["status"],
        generation["outputUrl"],
        generation["request"],
        generation["sourceUrl"],
    ) == ("image", "upload", "completed", confirmed["url"], None, None)
    assert generation["finishedAt"] is not None
    assert [item["id"] for item in listed.json()["items"]] == [upload_id]
    assert generated.json()["items"] == []


async def test_viewer_cannot_sign(client: httpx.AsyncClient) -> None:
    """新账号默认是 viewer：能查爆款视频，不能上传。"""

    await register_and_login(client)

    assert (await sign(client, "image/jpeg")).status_code == 403
    me = (await client.get("/users/me")).json()["user"]
    assert "inspirations:read" in me["permissions"]
    assert "uploads:write" not in me["permissions"]


async def test_routes_are_absent_without_a_bucket(base_env: None, migrated_pg: str) -> None:
    engine = create_async_engine(migrated_pg)
    try:
        app = build_app(make_runtime_config(), engine=engine)
        async with make_client(app) as http:
            assert (
                await http.post("/uploads/sign", json={"contentType": "image/jpeg"})
            ).status_code == 404
            assert (await http.post(f"/uploads/{uuid.uuid4()}/confirm")).status_code == 404
    finally:
        await engine.dispose()
