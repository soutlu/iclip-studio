from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.domains.generation.infra_sql import SqlGenerationRepository
from iclip.domains.generation.models import GenerationJob, GenerationOutput
from tests.helpers.app import (
    OBJECT_STORE_KEYS,
    TEST_OBJECT_STORE,
    make_client,
    make_runtime_config,
)
from tests.helpers.auth import set_roles_in_db
from tests.helpers.generation import MemoryObjectStore, make_job, make_music, video_request
from tests.helpers.references import FixedDurations, upload_audio
from tests.helpers.runtime_backed import build_backed_app

PASSWORD = "password-123"
URL = "/references/audios"
MUSIC_URL = "https://cdn.example.test/iclip/agent/generated-audio/m.wav"


@pytest.fixture
def bucket() -> MemoryObjectStore:
    return MemoryObjectStore()


@pytest.fixture
def durations() -> FixedDurations:
    return FixedDurations({MUSIC_URL: 95_000})


@pytest.fixture
async def http(
    base_env: None,
    engine: AsyncEngine,
    monkeypatch: pytest.MonkeyPatch,
    bucket: MemoryObjectStore,
    durations: FixedDurations,
) -> AsyncGenerator[httpx.AsyncClient]:
    for name, value in OBJECT_STORE_KEYS.items():
        monkeypatch.setenv(name, value)
    app: FastAPI = build_backed_app(
        make_runtime_config(object_store=TEST_OBJECT_STORE),
        engine=engine,
        object_store=bucket,
        reference_duration=durations,
    )
    async with make_client(app) as client:
        yield client


async def login_as(client: httpx.AsyncClient, pg_url: str, username: str, role: str) -> uuid.UUID:
    email = f"{username}@example.com"
    created = await client.post(
        "/auth/register", json={"email": email, "password": PASSWORD, "username": username}
    )
    if created.status_code == 201:
        await set_roles_in_db(pg_url, email, [role])
    logged_in = await client.post("/auth/login", data={"username": username, "password": PASSWORD})
    assert logged_in.status_code == 204, logged_in.text
    return uuid.UUID((await client.get("/users/me")).json()["user"]["id"])


async def own_audio(
    http: httpx.AsyncClient, bucket: MemoryObjectStore, durations: FixedDurations, ms: int
) -> str:
    upload_id, url = await upload_audio(http, bucket)
    durations.durations[url] = ms
    return upload_id


def voice(upload_id: str, **fields: Any) -> dict[str, Any]:
    return {"uploadId": upload_id, "title": "温柔女声", "audioKind": "voice", **fields}


async def finished(engine: AsyncEngine, job: GenerationJob, url: str) -> GenerationJob:
    repo = SqlGenerationRepository(engine)
    created = await repo.create(job)
    await repo.mark_completed(
        created.id, output=GenerationOutput(url=url), provider_status="succeeded"
    )
    return created


async def test_anonymous_is_401(http: httpx.AsyncClient) -> None:
    for path in (URL, f"{URL}/filters", f"{URL}/{uuid.uuid4()}"):
        assert (await http.get(path)).status_code == 401


async def test_an_own_audio_upload_becomes_a_reference_audio_with_its_measured_length(
    http: httpx.AsyncClient, pg_url: str, bucket: MemoryObjectStore, durations: FixedDurations
) -> None:
    await login_as(http, pg_url, "maya", "editor")
    upload_id = await own_audio(http, bucket, durations, 12_340)

    created = await http.post(
        URL,
        json=voice(upload_id, description="门店口播", locale="zh", transcript="欢迎光临"),
    )
    again = await http.post(URL, json=voice(upload_id))

    assert created.status_code == 201, created.text
    body = created.json()
    assert {key: body[key] for key in ("title", "description", "durationMs")} == {
        "title": "温柔女声",
        "description": "门店口播",
        "durationMs": 12_340,
    }
    assert (body["audioKind"], body["locale"], body["transcript"]) == ("voice", "zh", "欢迎光临")
    assert (body["uploadId"], body["sourceJobId"], body["userName"], body["canEdit"]) == (
        upload_id,
        None,
        "maya",
        True,
    )
    assert again.status_code == 201, "每次加都是新的一条"
    assert again.json()["id"] != body["id"]


async def test_a_finished_music_the_caller_can_see_becomes_a_reference_audio(
    http: httpx.AsyncClient, pg_url: str, engine: AsyncEngine
) -> None:
    maya = await login_as(http, pg_url, "maya", "editor")
    music = await finished(engine, make_music(owner_user_id=maya, conversation_id=None), MUSIC_URL)
    take = await finished(
        engine, make_job(video_request(), owner_user_id=maya), "https://cdn.example.test/t.mp4"
    )

    created = await http.post(
        URL, json={"sourceJobId": str(music.id), "title": "轻快", "audioKind": "bgm"}
    )
    not_music = await http.post(
        URL, json={"sourceJobId": str(take.id), "title": "x", "audioKind": "bgm"}
    )
    await login_as(http, pg_url, "sara", "editor")
    not_hers = await http.post(
        URL, json={"sourceJobId": str(music.id), "title": "x", "audioKind": "bgm"}
    )

    assert created.status_code == 201, created.text
    assert (created.json()["url"], created.json()["sourceJobId"], created.json()["durationMs"]) == (
        MUSIC_URL,
        str(music.id),
        95_000,
    )
    assert (not_music.status_code, not_hers.status_code) == (404, 404)


async def test_someone_elses_or_a_non_audio_upload_is_404(
    http: httpx.AsyncClient, pg_url: str, bucket: MemoryObjectStore, durations: FixedDurations
) -> None:
    await login_as(http, pg_url, "maya", "editor")
    mayas = await own_audio(http, bucket, durations, 5_000)
    signed = await http.post("/uploads/sign", json={"contentType": "video/mp4"})
    video_id = signed.json()["uploadId"]
    await bucket.put_public_object(
        object_key=f"iclip/agent/uploads/{video_id}.mp4", content=b"x", content_type="video/mp4"
    )
    assert (await http.post(f"/uploads/{video_id}/confirm")).status_code == 200

    video = await http.post(URL, json=voice(video_id))
    missing = await http.post(URL, json=voice(str(uuid.uuid4())))
    await login_as(http, pg_url, "sara", "editor")
    others = await http.post(URL, json=voice(mayas))

    assert (video.status_code, missing.status_code, others.status_code) == (404, 404, 404)


@pytest.mark.parametrize(
    ("audio_kind", "ms", "status"),
    [
        ("voice", 2_000, 422),
        ("voice", 3_000, 201),
        ("voice", 30_000, 201),
        ("voice", 31_000, 422),
        ("bgm", 31_000, 201),
        ("sfx", 500, 201),
        ("voice", None, 422),
    ],
    ids=["音色2秒", "音色3秒", "音色30秒", "音色31秒", "配乐31秒", "音效半秒", "量不出时长"],
)
async def test_the_length_is_checked_when_added(
    http: httpx.AsyncClient,
    pg_url: str,
    bucket: MemoryObjectStore,
    durations: FixedDurations,
    audio_kind: str,
    ms: int | None,
    status: int,
) -> None:
    await login_as(http, pg_url, "maya", "editor")
    upload_id, url = await upload_audio(http, bucket)
    if ms is not None:
        durations.durations[url] = ms

    response = await http.post(URL, json=voice(upload_id, audioKind=audio_kind))

    assert response.status_code == status, response.text
    if status == 422:
        assert (await http.get(URL)).json()["total"] == 0


@pytest.mark.parametrize(
    "body",
    [
        {"audioKind": "bgm", "transcript": "这句不该有"},
        {"audioKind": "piano"},
        {"title": "   "},
        {"sourceJobId": str(uuid.uuid4())},
        {"locale": "ja"},
    ],
    ids=["配乐带台词", "不认识的子类", "标题空白", "两个来源都给", "不认识的语种"],
)
async def test_a_malformed_body_is_422(
    http: httpx.AsyncClient,
    pg_url: str,
    bucket: MemoryObjectStore,
    durations: FixedDurations,
    body: dict[str, Any],
) -> None:
    await login_as(http, pg_url, "maya", "editor")
    upload_id = await own_audio(http, bucket, durations, 5_000)

    response = await http.post(URL, json=voice(upload_id, **body))

    assert response.status_code == 422, response.text


async def test_the_list_filters_pages_and_counts(
    http: httpx.AsyncClient, pg_url: str, bucket: MemoryObjectStore, durations: FixedDurations
) -> None:
    await login_as(http, pg_url, "maya", "editor")
    added: dict[str, str] = {}
    for name, kind, locale, title in (
        ("zh_voice", "voice", "zh", "中文女声"),
        ("en_voice", "voice", "en", "English voice"),
        ("bgm", "bgm", None, "夏日配乐"),
    ):
        upload_id = await own_audio(http, bucket, durations, 5_000)
        created = await http.post(
            URL, json={"uploadId": upload_id, "title": title, "audioKind": kind, "locale": locale}
        )
        added[name] = created.json()["id"]
    await login_as(http, pg_url, "sara", "editor")
    upload_id = await own_audio(http, bucket, durations, 5_000)
    saras = (
        await http.post(URL, json={"uploadId": upload_id, "title": "音效", "audioKind": "sfx"})
    ).json()["id"]
    removed = (
        await http.post(URL, json={"uploadId": upload_id, "title": "删掉", "audioKind": "sfx"})
    ).json()["id"]
    assert (await http.delete(f"{URL}/{removed}")).status_code == 204

    async def ids(**params: Any) -> list[str]:
        page = (await http.get(URL, params=params)).json()
        return [item["id"] for item in page["items"]]

    assert await ids() == [saras, added["bgm"], added["en_voice"], added["zh_voice"]]
    assert await ids(audioKind="voice") == [added["en_voice"], added["zh_voice"]]
    assert await ids(locale="zh") == [added["zh_voice"]]
    assert await ids(userName="sara") == [saras]
    assert await ids(q="配乐") == [added["bgm"]]
    first = (await http.get(URL, params={"limit": 2})).json()
    rest = (await http.get(URL, params={"limit": 2, "cursor": first["nextCursor"]})).json()
    assert (first["total"], rest["total"]) == (4, None)
    assert [item["id"] for item in first["items"] + rest["items"]] == await ids()
    assert (await http.get(URL, params={"audioKind": "piano"})).status_code == 422
    assert (await http.get(f"{URL}/filters")).json() == {
        "audioKinds": [
            {"audioKind": "voice", "count": 2},
            {"audioKind": "bgm", "count": 1},
            {"audioKind": "sfx", "count": 1},
        ],
        "owners": [{"userName": "maya", "count": 3}, {"userName": "sara", "count": 1}],
    }


async def test_the_owner_or_a_governor_edits_and_removes(
    http: httpx.AsyncClient, pg_url: str, bucket: MemoryObjectStore, durations: FixedDurations
) -> None:
    await login_as(http, pg_url, "maya", "editor")
    voice_id = (
        await http.post(
            URL,
            json=voice(
                await own_audio(http, bucket, durations, 5_000),
                description="旧备注",
                transcript="旧台词",
            ),
        )
    ).json()["id"]
    bgm_id = (
        await http.post(
            URL,
            json={
                "uploadId": await own_audio(http, bucket, durations, 5_000),
                "title": "配乐",
                "audioKind": "bgm",
            },
        )
    ).json()["id"]
    path = f"{URL}/{voice_id}"

    await login_as(http, pg_url, "sara", "editor")
    seen = await http.get(path)
    assert (seen.status_code, seen.json()["canEdit"]) == (200, False)
    assert (await http.patch(path, json={"title": "抢改"})).status_code == 403
    assert (await http.delete(path)).status_code == 403

    await login_as(http, pg_url, "maya", "editor")
    edited = await http.patch(
        path, json={"title": "新标题", "description": None, "locale": "en", "transcript": "Hi"}
    )
    untouched = await http.patch(path, json={"locale": "de"})
    cleared_title = await http.patch(path, json={"title": None})
    bgm_with_transcript = await http.patch(f"{URL}/{bgm_id}", json={"transcript": "不该有"})

    assert edited.status_code == 200, edited.text
    assert {
        key: edited.json()[key] for key in ("title", "description", "locale", "transcript")
    } == {
        "title": "新标题",
        "description": None,
        "locale": "en",
        "transcript": "Hi",
    }
    assert (untouched.json()["title"], untouched.json()["locale"]) == ("新标题", "de")
    assert (cleared_title.status_code, bgm_with_transcript.status_code) == (422, 422)

    await login_as(http, pg_url, "ada", "admin")
    by_governor = await http.patch(path, json={"title": "治理者改的"})
    assert by_governor.status_code == 200, by_governor.text

    await login_as(http, pg_url, "maya", "editor")
    assert (await http.delete(path)).status_code == 204
    assert (await http.get(path)).status_code == 404
    assert (await http.patch(path, json={"title": "x"})).status_code == 404
    assert [item["id"] for item in (await http.get(URL)).json()["items"]] == [bgm_id]


async def test_a_viewer_reads_but_cannot_add(
    http: httpx.AsyncClient, pg_url: str, bucket: MemoryObjectStore, durations: FixedDurations
) -> None:
    await login_as(http, pg_url, "maya", "editor")
    upload_id = await own_audio(http, bucket, durations, 5_000)
    await login_as(http, pg_url, "vera", "viewer")

    listed = await http.get(URL)
    added = await http.post(URL, json=voice(upload_id))

    assert (listed.status_code, listed.json()["canUpload"]) == (200, False)
    assert added.status_code == 403
