from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.domains.generation.infra_sql import SqlGenerationRepository
from iclip.domains.generation.models import GenerationJob, GenerationOutput
from iclip.domains.references.models import PEAK_BUCKETS
from iclip.platform.media.process import ffmpeg_available
from tests.helpers.app import (
    OBJECT_STORE_KEYS,
    TEST_OBJECT_STORE,
    make_client,
    make_runtime_config,
)
from tests.helpers.auth import set_roles_in_db
from tests.helpers.generation import MemoryObjectStore, make_job, make_music, video_request
from tests.helpers.media import synthesize_padded_music
from tests.helpers.media_server import serving
from tests.helpers.references import FIXED_PEAKS, FixedMeasurements, upload_audio
from tests.helpers.runtime_backed import build_backed_app

PASSWORD = "password-123"
URL = "/references/audios"
MUSIC_URL = "https://cdn.example.test/iclip/agent/generated-audio/m.wav"
NO_TRAITS: dict[str, Any] = {
    "gender": None,
    "age": None,
    "scenarios": [],
    "mood": None,
    "genre": None,
    "bpm": None,
    "sfxCategory": None,
}
TRAIT_KEYS = tuple(NO_TRAITS)


@pytest.fixture
def bucket() -> MemoryObjectStore:
    return MemoryObjectStore()


@pytest.fixture
def durations() -> FixedMeasurements:
    return FixedMeasurements({MUSIC_URL: 95_000})


@pytest.fixture
async def http(
    base_env: None,
    engine: AsyncEngine,
    monkeypatch: pytest.MonkeyPatch,
    bucket: MemoryObjectStore,
    durations: FixedMeasurements,
) -> AsyncGenerator[httpx.AsyncClient]:
    for name, value in OBJECT_STORE_KEYS.items():
        monkeypatch.setenv(name, value)
    app: FastAPI = build_backed_app(
        make_runtime_config(object_store=TEST_OBJECT_STORE),
        engine=engine,
        object_store=bucket,
        reference_audio_measure=durations,
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
    http: httpx.AsyncClient, bucket: MemoryObjectStore, durations: FixedMeasurements, ms: int
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
    http: httpx.AsyncClient, pg_url: str, bucket: MemoryObjectStore, durations: FixedMeasurements
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
    assert body["peaks"] == list(FIXED_PEAKS)
    assert {key: body[key] for key in TRAIT_KEYS} == NO_TRAITS
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
    http: httpx.AsyncClient, pg_url: str, bucket: MemoryObjectStore, durations: FixedMeasurements
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
    durations: FixedMeasurements,
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
        {"mood": "warm"},
        {"sfxCategory": "ui"},
        {"audioKind": "bgm", "gender": "female"},
        {"audioKind": "sfx", "bpm": 100},
        {"scenarios": ["social", "trailers", "wellness"]},
        {"scenarios": ["social", "social"]},
        {"audioKind": "bgm", "bpm": 301},
    ],
    ids=[
        "配乐带台词",
        "不认识的子类",
        "标题空白",
        "两个来源都给",
        "不认识的语种",
        "音色带情绪",
        "音色带音效类别",
        "配乐带性别",
        "音效带bpm",
        "场景超过2个",
        "场景重复",
        "bpm超出范围",
    ],
)
async def test_a_malformed_body_is_422(
    http: httpx.AsyncClient,
    pg_url: str,
    bucket: MemoryObjectStore,
    durations: FixedMeasurements,
    body: dict[str, Any],
) -> None:
    await login_as(http, pg_url, "maya", "editor")
    upload_id = await own_audio(http, bucket, durations, 5_000)

    response = await http.post(URL, json=voice(upload_id, **body))

    assert response.status_code == 422, response.text


async def test_the_list_filters_pages_and_counts(
    http: httpx.AsyncClient, pg_url: str, bucket: MemoryObjectStore, durations: FixedMeasurements
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


async def test_the_list_filters_by_traits_any_within_a_parameter_and_all_across(
    http: httpx.AsyncClient, pg_url: str, bucket: MemoryObjectStore, durations: FixedMeasurements
) -> None:
    await login_as(http, pg_url, "maya", "editor")

    async def add(**fields: Any) -> str:
        upload_id = await own_audio(http, bucket, durations, 5_000)
        created = await http.post(URL, json={"uploadId": upload_id, "title": "x", **fields})
        assert created.status_code == 201, created.text
        return str(created.json()["id"])

    zh_young = await add(
        audioKind="voice",
        locale="zh",
        gender="female",
        age="young",
        scenarios=["commercials", "social"],
    )
    en_senior = await add(
        audioKind="voice", locale="en", gender="male", age="senior", scenarios=["documentaries"]
    )
    unset_locale = await add(audioKind="voice", gender="female", age="middle")
    bpm_89 = await add(audioKind="bgm", bpm=89, mood="warm", genre="piano")
    bpm_90 = await add(audioKind="bgm", bpm=90, mood="epic", genre="orchestral")
    bpm_120 = await add(audioKind="bgm", bpm=120, mood="warm", genre="acoustic")
    bpm_121 = await add(audioKind="bgm", bpm=121, mood="relaxed")
    await add(audioKind="bgm", mood="relaxed")
    await add(audioKind="sfx", sfxCategory="transition")
    impact = await add(audioKind="sfx", sfxCategory="impact")

    async def ids(**params: Any) -> set[str]:
        listed = await http.get(URL, params=params)
        assert listed.status_code == 200, listed.text
        return {item["id"] for item in listed.json()["items"]}

    assert await ids(gender="female") == {zh_young, unset_locale}
    assert await ids(gender=["female", "male"]) == {zh_young, en_senior, unset_locale}
    assert await ids(gender="female", age="young") == {zh_young}
    assert await ids(scenario="social") == {zh_young}
    assert await ids(scenario=["social", "documentaries"]) == {zh_young, en_senior}
    assert await ids(audioKind="voice", locale="none") == {unset_locale}
    assert await ids(audioKind="voice", locale=["zh", "none"]) == {zh_young, unset_locale}
    assert await ids(tempo="slow") == {bpm_89}
    assert await ids(tempo="medium") == {bpm_90, bpm_120}
    assert await ids(tempo="fast") == {bpm_121}
    assert await ids(tempo=["slow", "fast"]) == {bpm_89, bpm_121}, "没填 bpm 的不落在任何档"
    assert await ids(mood="warm") == {bpm_89, bpm_120}
    assert await ids(mood=["warm", "relaxed"], genre="piano") == {bpm_89}
    assert await ids(sfxCategory="impact") == {impact}
    assert (await http.get(URL, params={"mood": "relaxed"})).json()["total"] == 2
    for bad in ({"tempo": "quick"}, {"locale": "ja"}, {"scenario": "ads"}):
        assert (await http.get(URL, params=bad)).status_code == 422, bad


async def test_traits_are_set_changed_and_cleared_within_their_kind(
    http: httpx.AsyncClient, pg_url: str, bucket: MemoryObjectStore, durations: FixedMeasurements
) -> None:
    await login_as(http, pg_url, "maya", "editor")
    voice_id = (
        await http.post(
            URL,
            json=voice(
                await own_audio(http, bucket, durations, 5_000),
                gender="female",
                age="young",
                scenarios=["social", "explainers"],
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
                "mood": "epic",
                "genre": "orchestral",
                "bpm": 128,
            },
        )
    ).json()["id"]
    sfx = await http.post(
        URL,
        json={
            "uploadId": await own_audio(http, bucket, durations, 5_000),
            "title": "提示音",
            "audioKind": "sfx",
            "sfxCategory": "ui",
        },
    )

    def traits(response: httpx.Response) -> dict[str, Any]:
        assert response.status_code == 200, response.text
        assert response.json()["peaks"] == list(FIXED_PEAKS), "改属性不动波形"
        return {key: response.json()[key] for key in TRAIT_KEYS}

    voice_path, bgm_path = f"{URL}/{voice_id}", f"{URL}/{bgm_id}"
    assert traits(await http.get(voice_path)) == {
        **NO_TRAITS,
        "gender": "female",
        "age": "young",
        "scenarios": ["social", "explainers"],
    }
    assert traits(await http.get(bgm_path)) == {
        **NO_TRAITS,
        "mood": "epic",
        "genre": "orchestral",
        "bpm": 128,
    }
    assert sfx.json()["sfxCategory"] == "ui"

    changed = await http.patch(voice_path, json={"age": "senior", "scenarios": ["wellness"]})
    assert traits(changed) == {
        **NO_TRAITS,
        "gender": "female",
        "age": "senior",
        "scenarios": ["wellness"],
    }
    cleared = await http.patch(voice_path, json={"gender": None, "scenarios": []})
    assert traits(cleared) == {**NO_TRAITS, "age": "senior"}
    no_bpm = await http.patch(bgm_path, json={"bpm": None})
    assert traits(no_bpm) == {**NO_TRAITS, "mood": "epic", "genre": "orchestral"}
    assert (await http.patch(bgm_path, json={"gender": "male"})).status_code == 422
    clearing_foreign = await http.patch(bgm_path, json={"gender": None, "scenarios": []})
    assert traits(clearing_foreign) == traits(no_bpm), "清空别的子类的属性什么都不改"


async def test_an_entry_stored_without_traits_or_peaks_reads_as_unset(
    http: httpx.AsyncClient, pg_url: str, engine: AsyncEngine
) -> None:
    maya = await login_as(http, pg_url, "maya", "editor")
    reference_id = uuid.uuid4()
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "INSERT INTO iclip.references (id, kind, title, url, duration_ms, owner_user_id)"
                " VALUES (:id, 'audio', '旧配乐', 'https://cdn.example.test/old.mp3', 5000, :owner)"
            ),
            {"id": reference_id, "owner": maya},
        )
        await conn.execute(
            text(
                "INSERT INTO iclip.reference_audios (reference_id, audio_kind) VALUES (:id, 'bgm')"
            ),
            {"id": reference_id},
        )

    listed = (await http.get(URL)).json()["items"]
    edited = await http.patch(f"{URL}/{reference_id}", json={"mood": "warm"})

    assert [(item["id"], item["peaks"]) for item in listed] == [(str(reference_id), None)]
    assert {key: listed[0][key] for key in TRAIT_KEYS} == NO_TRAITS
    assert edited.status_code == 200, edited.text
    assert (edited.json()["mood"], edited.json()["peaks"]) == ("warm", None)


@pytest.mark.skipif(not ffmpeg_available(), reason="本机 PATH 上没有 ffmpeg/ffprobe")
async def test_an_added_audio_carries_the_waveform_measured_from_its_file(
    base_env: None,
    engine: AsyncEngine,
    monkeypatch: pytest.MonkeyPatch,
    bucket: MemoryObjectStore,
    pg_url: str,
) -> None:
    for name, value in OBJECT_STORE_KEYS.items():
        monkeypatch.setenv(name, value)
    app = build_backed_app(
        make_runtime_config(object_store=TEST_OBJECT_STORE), engine=engine, object_store=bucket
    )
    with TemporaryDirectory(prefix="reference-peaks-") as tmp:
        tone = synthesize_padded_music(Path(tmp) / "tone.wav", lead=1.0, body=2.0, tail=0.5)
    async with (
        serving({"tone.wav": tone, "broken.m4a": b"not audio at all"}) as server,
        make_client(app) as client,
    ):
        maya = await login_as(client, pg_url, "maya", "editor")
        music = await finished(
            engine, make_music(owner_user_id=maya, conversation_id=None), server.url("tone.wav")
        )
        broken = await finished(
            engine, make_music(owner_user_id=maya, conversation_id=None), server.url("broken.m4a")
        )
        created = await client.post(
            URL, json={"sourceJobId": str(music.id), "title": "提示音", "audioKind": "bgm"}
        )
        unreadable = await client.post(
            URL, json={"sourceJobId": str(broken.id), "title": "坏的", "audioKind": "bgm"}
        )
        stored = (await client.get(f"{URL}/{created.json()['id']}")).json()

    assert created.status_code == 201, created.text
    assert abs(stored["durationMs"] - 3_500) <= 100
    peaks = stored["peaks"]
    assert (len(peaks), max(peaks)) == (PEAK_BUCKETS, 1.0)
    assert (peaks[0], peaks[-1]) == (0.0, 0.0), "开头与结尾的静音在波形上是 0"
    assert min(peaks[40:100]) > 0.9, "中间是等幅的正弦波"
    assert unreadable.status_code == 422, unreadable.text


async def test_the_owner_or_a_governor_edits_and_removes(
    http: httpx.AsyncClient, pg_url: str, bucket: MemoryObjectStore, durations: FixedMeasurements
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
    http: httpx.AsyncClient, pg_url: str, bucket: MemoryObjectStore, durations: FixedMeasurements
) -> None:
    await login_as(http, pg_url, "maya", "editor")
    upload_id = await own_audio(http, bucket, durations, 5_000)
    await login_as(http, pg_url, "vera", "viewer")

    listed = await http.get(URL)
    added = await http.post(URL, json=voice(upload_id))

    assert (listed.status_code, listed.json()["canUpload"]) == (200, False)
    assert added.status_code == 403
