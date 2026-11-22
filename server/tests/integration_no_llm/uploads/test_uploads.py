from __future__ import annotations

import hashlib
import uuid
from collections.abc import AsyncGenerator
from datetime import UTC, datetime
from urllib.parse import urlsplit

import httpx
import pytest
from fastapi import FastAPI
from procrastinate.testing import InMemoryConnector
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.domains.generation.infra_sql import SqlGenerationRepository
from iclip.domains.generation.models import GenerationOutput
from iclip.domains.uploads.infra_sql import SqlUploadRepository
from iclip.domains.uploads.models import MediaUpload
from iclip.platform.db.engine import build_engine
from iclip.platform.media.codec import SOFTWARE
from tests.helpers.agents import CONVERSABLE_SEEDS, seed_agents
from tests.helpers.app import (
    OBJECT_STORE_KEYS,
    TEST_OBJECT_STORE,
    make_client,
    make_runtime_config,
)
from tests.helpers.auth import login_as_editor, register_and_login, set_roles_in_db
from tests.helpers.generation import MEDIA_ENVS, MemoryObjectStore, config_with_media, make_music
from tests.helpers.model_providers import GOOD_KEY, KeyCheckingProbe
from tests.helpers.pg import connected
from tests.helpers.runtime_backed import build_backed_app, config_services_of


@pytest.fixture
def bucket() -> MemoryObjectStore:
    return MemoryObjectStore()


@pytest.fixture
async def uploads_app(
    base_env: None,
    engine: AsyncEngine,
    monkeypatch: pytest.MonkeyPatch,
    bucket: MemoryObjectStore,
) -> FastAPI:
    for name, value in OBJECT_STORE_KEYS.items():
        monkeypatch.setenv(name, value)
    built = build_backed_app(
        make_runtime_config(object_store=TEST_OBJECT_STORE),
        engine=engine,
        object_store=bucket,
        credential_probe=KeyCheckingProbe({GOOD_KEY}),
    )
    await seed_agents(config_services_of(built), engine, CONVERSABLE_SEEDS)
    return built


@pytest.fixture
async def client(uploads_app: FastAPI) -> AsyncGenerator[httpx.AsyncClient]:
    async with make_client(uploads_app) as c:
        yield c


async def sign(client: httpx.AsyncClient, content_type: str) -> httpx.Response:
    return await client.post(
        "/uploads/sign", json={"contentType": content_type, "width": 1200, "height": 1600}
    )


async def test_upload_round_trip_hands_back_the_record(
    client: httpx.AsyncClient, pg_url: str, bucket: MemoryObjectStore
) -> None:
    user_id = await login_as_editor(client, pg_url)

    signed = await sign(client, "video/mp4")
    assert signed.status_code == 200, signed.text
    ticket = signed.json()
    upload_id = ticket["uploadId"]
    assert str(uuid.UUID(upload_id)) == upload_id
    upload_url = urlsplit(ticket["upload"]["url"])
    assert upload_url.scheme == "https" and upload_url.netloc
    assert upload_url.path.endswith(f"/{upload_id}.mp4")
    assert ticket["upload"]["method"] == "PUT"
    assert datetime.fromisoformat(ticket["upload"]["expiresAt"]) > datetime.now(UTC)
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
    body = confirmed.json()
    assert {key: value for key, value in body.items() if key != "createdAt"} == {
        "id": upload_id,
        "kind": "video",
        "url": f"https://cdn.example.test/iclip/agent/uploads/{upload_id}.mp4",
        "contentType": "video/mp4",
        "sizeBytes": 70,
        "durationMs": None,
        "width": None,
        "height": None,
        "conversationId": None,
    }, "大小与类型取对象存储报的，时长不量，视频不记宽高"
    again = await client.post(f"/uploads/{upload_id}/confirm")
    assert again.json() == body


async def test_confirming_something_nobody_uploaded_is_a_conflict(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    await login_as_editor(client, pg_url)

    assert (await client.post(f"/uploads/{uuid.uuid4()}/confirm")).status_code == 409
    assert await upload_rows(pg_url) == 0, "核对不过不落记录"


async def uploaded(
    client: httpx.AsyncClient, bucket: MemoryObjectStore, content_type: str, ext: str
) -> tuple[str, str]:
    upload_id = (await sign(client, content_type)).json()["uploadId"]
    key = f"iclip/agent/uploads/{upload_id}.{ext}"
    await bucket.put_public_object(object_key=key, content=b"x" * 10, content_type=content_type)
    return upload_id, key


async def stored(pg_url: str, upload_id: str) -> MediaUpload:
    engine = build_engine(pg_url)
    try:
        found = await SqlUploadRepository(engine).get(uuid.UUID(upload_id))
    finally:
        await engine.dispose()
    assert found is not None
    return found


async def upload_rows(pg_url: str) -> int:
    async with connected(pg_url) as conn:
        found = await conn.execute(text("SELECT count(*) FROM iclip.media_uploads"))
        return int(found.scalar_one())


@pytest.mark.parametrize(
    ("content_type", "ext", "kind"),
    [
        ("image/png", "png", "image"),
        ("video/mp4", "mp4", "video"),
        ("audio/mpeg", "mp3", "audio"),
        ("audio/wav", "wav", "audio"),
        ("audio/mp4", "m4a", "audio"),
    ],
)
async def test_confirming_records_an_upload_even_without_media_generation(
    client: httpx.AsyncClient,
    pg_url: str,
    bucket: MemoryObjectStore,
    content_type: str,
    ext: str,
    kind: str,
) -> None:
    user_id = await login_as_editor(client, pg_url)
    upload_id, _ = await uploaded(client, bucket, content_type, ext)

    confirmed = await client.post(
        f"/uploads/{upload_id}/confirm", json={"width": 1200, "height": 1600}
    )

    assert confirmed.status_code == 200, confirmed.text
    row = await stored(pg_url, upload_id)
    image = kind == "image"
    assert (
        row.kind,
        row.url,
        row.content_type,
        row.size_bytes,
        row.duration_ms,
        row.width,
        row.height,
        row.conversation_id,
        row.owner_user_id,
        row.api_key_id,
    ) == (
        kind,
        confirmed.json()["url"],
        content_type,
        10,
        None,
        1200 if image else None,
        1600 if image else None,
        None,
        uuid.UUID(user_id),
        None,
    ), "只有图片记报上来的宽高；时长不量"


async def test_confirming_again_keeps_the_one_record_and_its_first_owner(
    uploads_app: FastAPI, pg_url: str, bucket: MemoryObjectStore
) -> None:
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
            upload_id, _ = await uploaded(gateway, bucket, "image/png", "png")
            first = await gateway.post(
                f"/uploads/{upload_id}/confirm", json={"userName": "Sara.Hong"}
            )
            again = await gateway.post(
                f"/uploads/{upload_id}/confirm", json={"userName": "Eva.Lin"}
            )
        users = (await root.get("/users")).json()["items"]

    assert first.status_code == 200, first.text
    assert again.json() == first.json()
    assert await upload_rows(pg_url) == 1
    row = await stored(pg_url, upload_id)
    sara = next(user["id"] for user in users if user["username"] == "Sara.Hong")
    assert (str(row.owner_user_id), str(row.api_key_id)) == (sara, issued["id"])


async def confirmed_upload(
    http: httpx.AsyncClient,
    bucket: MemoryObjectStore,
    content: bytes,
    content_type: str = "video/mp4",
    ext: str = "mp4",
) -> tuple[str, str, dict[str, object]]:
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

    assert first["url"] == f"https://cdn.example.test/{first_key}"
    assert (second["id"], second["url"], second["sizeBytes"]) == (second_id, first["url"], 70)
    assert again.status_code == 200, again.text
    assert again.json() == second
    assert (first_key in bucket.objects, second_key in bucket.objects) == (True, False)
    assert await upload_rows(pg_url) == 2
    first_row, second_row = await stored(pg_url, first_id), await stored(pg_url, second_id)
    md5 = hashlib.md5(content).hexdigest()
    assert (first_row.owner_user_id, first_row.url, first_row.content_md5) == (
        uuid.UUID(first_user_id),
        first["url"],
        md5,
    )
    assert (second_row.owner_user_id, second_row.url, second_row.content_md5) == (
        uuid.UUID(second_user_id),
        first["url"],
        md5,
    )


@pytest.mark.parametrize(
    ("content_type", "ext"), [("image/png", "png"), ("audio/mpeg", "mp3")], ids=["图片", "音乐"]
)
async def test_the_same_image_or_music_uploaded_twice_keeps_two_addresses(
    client: httpx.AsyncClient, pg_url: str, bucket: MemoryObjectStore, content_type: str, ext: str
) -> None:
    await login_as_editor(client, pg_url)
    content = b"MEDIADATA" * 10
    first_id, first_key, first = await confirmed_upload(client, bucket, content, content_type, ext)
    second_id, second_key, second = await confirmed_upload(
        client, bucket, content, content_type, ext
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
    base_env: None, engine: AsyncEngine, monkeypatch: pytest.MonkeyPatch, bucket: MemoryObjectStore
) -> FastAPI:
    for name, value in MEDIA_ENVS.items():
        monkeypatch.setenv(name, value)
    built = build_backed_app(
        config_with_media(),
        engine=engine,
        object_store=bucket,
        queue_connector=InMemoryConnector(),
        media_codec=SOFTWARE,
        credential_probe=KeyCheckingProbe({GOOD_KEY}),
    )
    await seed_agents(config_services_of(built), engine, CONVERSABLE_SEEDS)
    return built


@pytest.mark.parametrize(
    ("content_type", "ext"),
    [("image/png", "png"), ("video/mp4", "mp4"), ("audio/mp4", "m4a")],
    ids=["图片", "视频", "音乐"],
)
async def test_an_upload_is_not_a_generation_record(
    media_app: FastAPI, pg_url: str, bucket: MemoryObjectStore, content_type: str, ext: str
) -> None:
    async with make_client(media_app) as http:
        await login_as_editor(http, pg_url)
        upload_id, _ = await uploaded(http, bucket, content_type, ext)
        assert (await http.post(f"/uploads/{upload_id}/confirm")).status_code == 200
        record = await http.get(f"/generations/{upload_id}")
        listed = await http.get("/generations")

    assert record.status_code == 404
    assert listed.json()["items"] == []
    assert await upload_rows(pg_url) == 1


async def open_conversation(http: httpx.AsyncClient) -> str:
    created = await http.post("/conversations", json={"agentId": "director"})
    assert created.status_code == 201, created.text
    return str(created.json()["conversation"]["id"])


async def test_music_attached_to_a_conversation_is_listed_by_that_conversation(
    media_app: FastAPI, pg_url: str, bucket: MemoryObjectStore
) -> None:
    async with make_client(media_app) as http:
        owner = await login_as_editor(http, pg_url)
        mine, another = await open_conversation(http), await open_conversation(http)
        engine = build_engine(pg_url)
        try:
            repo = SqlGenerationRepository(engine)
            generated = await repo.create(
                make_music(owner_user_id=uuid.UUID(owner), conversation_id=uuid.UUID(mine))
            )
            await repo.mark_completed(
                generated.id,
                output=GenerationOutput(url="https://example.test/music.m4a", duration_ms=30_000),
                provider_status="succeeded",
            )
        finally:
            await engine.dispose()
        music_id, _ = await uploaded(http, bucket, "audio/mpeg", "mp3")
        picture_id, _ = await uploaded(http, bucket, "image/png", "png")
        loose_id, _ = await uploaded(http, bucket, "audio/mpeg", "mp3")

        confirmed = await http.post(f"/uploads/{music_id}/confirm", json={"conversationId": mine})
        again = await http.post(f"/uploads/{music_id}/confirm", json={"conversationId": another})
        await http.post(f"/uploads/{picture_id}/confirm", json={"conversationId": mine})
        await http.post(f"/uploads/{loose_id}/confirm")
        audio = await http.get(f"/conversations/{mine}/uploads", params={"kind": "audio"})
        everything = await http.get(f"/conversations/{mine}/uploads")
        elsewhere = await http.get(f"/conversations/{another}/uploads", params={"kind": "audio"})
        generated_audio = await http.get(
            "/generations", params={"kind": "audio", "conversationId": mine}
        )

    assert confirmed.status_code == 200, confirmed.text
    assert again.json() == confirmed.json()
    assert confirmed.json()["conversationId"] == mine
    assert [item["id"] for item in audio.json()["items"]] == [music_id]
    assert [item["id"] for item in everything.json()["items"]] == [picture_id, music_id], "新的在前"
    assert elsewhere.json()["items"] == []
    assert [item["id"] for item in generated_audio.json()["items"]] == [str(generated.id)]


async def test_a_conversations_uploads_are_listed_for_whoever_can_read_it(
    uploads_app: FastAPI, pg_url: str, bucket: MemoryObjectStore
) -> None:
    async with (
        make_client(uploads_app) as owner,
        make_client(uploads_app) as stranger,
        make_client(uploads_app) as governor,
    ):
        await login_as_editor(owner, pg_url)
        await login_as_editor(stranger, pg_url, username="mallory")
        await register_and_login(governor, username="gov", email="gov@example.com")
        await set_roles_in_db(pg_url, "gov@example.com", ["root"])
        conversation = await open_conversation(owner)
        upload_id, _ = await uploaded(owner, bucket, "audio/mpeg", "mp3")
        await owner.post(f"/uploads/{upload_id}/confirm", json={"conversationId": conversation})
        path = f"/conversations/{conversation}/uploads"

        seen_by_owner = await owner.get(path)
        seen_by_governor = await governor.get(path)
        seen_by_stranger = await stranger.get(path)

    assert [item["id"] for item in seen_by_owner.json()["items"]] == [upload_id]
    assert [item["id"] for item in seen_by_governor.json()["items"]] == [upload_id]
    assert seen_by_stranger.status_code == 404, "看不见的对话不暴露它有没有上传"


async def test_listing_a_conversations_uploads_needs_generation_read(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    await register_and_login(client)
    await set_roles_in_db(pg_url, "logan@example.com", [])

    assert (await client.get(f"/conversations/{uuid.uuid4()}/uploads")).status_code == 403


@pytest.mark.parametrize(
    ("content_type", "ext", "whose", "status"),
    [
        pytest.param("image/png", "png", "own", 200, id="图片挂自己的对话"),
        pytest.param("video/mp4", "mp4", "own", 200, id="视频挂自己的对话"),
        pytest.param("audio/mpeg", "mp3", "stranger", 404, id="看不见的对话"),
        pytest.param("audio/mpeg", "mp3", "governor", 403, id="治理者挂别人的对话"),
    ],
)
async def test_any_kind_can_be_attached_but_only_to_ones_own_conversation(
    uploads_app: FastAPI,
    pg_url: str,
    bucket: MemoryObjectStore,
    content_type: str,
    ext: str,
    whose: str,
    status: int,
) -> None:
    async with make_client(uploads_app) as owner, make_client(uploads_app) as other:
        await login_as_editor(owner, pg_url)
        conversation = await open_conversation(owner)
        if whose == "own":
            uploader = owner
        elif whose == "stranger":
            await login_as_editor(other, pg_url, username="mallory")
            uploader = other
        else:
            await register_and_login(other, username="gov", email="gov@example.com")
            await set_roles_in_db(pg_url, "gov@example.com", ["root"])
            uploader = other
        upload_id, _ = await uploaded(uploader, bucket, content_type, ext)

        response = await uploader.post(
            f"/uploads/{upload_id}/confirm", json={"conversationId": conversation}
        )

    assert response.status_code == status, response.text
    if status == 200:
        assert (await stored(pg_url, upload_id)).conversation_id == uuid.UUID(conversation)
    else:
        assert await upload_rows(pg_url) == 0


async def test_viewer_cannot_sign(client: httpx.AsyncClient) -> None:
    await register_and_login(client)

    assert (await sign(client, "image/jpeg")).status_code == 403
    me = (await client.get("/users/me")).json()["user"]
    assert "inspirations:read" in me["permissions"]
    assert "uploads:write" not in me["permissions"]


async def test_routes_are_absent_without_a_bucket(base_env: None, migrated_pg: str) -> None:
    engine = build_engine(migrated_pg)
    try:
        app = build_backed_app(make_runtime_config(), engine=engine)
        async with make_client(app) as http:
            assert (
                await http.post("/uploads/sign", json={"contentType": "image/jpeg"})
            ).status_code == 404
            assert (await http.post(f"/uploads/{uuid.uuid4()}/confirm")).status_code == 404
            assert (await http.get(f"/conversations/{uuid.uuid4()}/uploads")).status_code == 404
    finally:
        await engine.dispose()
