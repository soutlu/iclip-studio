from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.domains.conversations.infra_sql import SqlConversationRepository
from iclip.domains.generation.infra_sql import SqlGenerationRepository
from iclip.domains.generation.models import (
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_SUBMITTED,
    GenerationJob,
)
from iclip.domains.generation.queue import GenerationQueue, StillRunning
from iclip.domains.generation.render import PROVIDER_NAME
from iclip.domains.generation.schemas import (
    KIND_VIDEO,
    KIND_WHOLE_FILM,
    OPERATION_ENHANCE,
    OPERATION_RENDER,
    WholeFilmAudioSource,
    WholeFilmRequest,
    WholeFilmVideoSource,
)
from iclip.domains.generation.video import PROVIDER_NAME as VIDEO_PROVIDER_NAME
from tests.helpers.app import make_client
from tests.helpers.auth import login_as_editor, register_and_login, set_roles_in_db
from tests.helpers.fork_lineage import complete, finished, make_user, open_conversation
from tests.helpers.generation import make_enhancement, make_job, make_music, video_request
from tests.helpers.render import StubRender, film_file, rewritten
from tests.helpers.whole_film import build_whole_film_app

URL = "/conversations"

PUBLIC = "https://cdn.example.test"

INTERNAL_HOST = "iclip-test.oss-ap-southeast-1-internal.aliyuncs.com"


@pytest.fixture
def render() -> StubRender:
    return StubRender()


@pytest.fixture
async def export_app(
    base_env: None, engine: AsyncEngine, monkeypatch: pytest.MonkeyPatch, render: StubRender
) -> FastAPI:
    return await build_whole_film_app(monkeypatch, engine, render)


@pytest.fixture
async def client(export_app: FastAPI) -> AsyncGenerator[httpx.AsyncClient]:
    async with make_client(export_app) as http:
        yield http


@pytest.fixture
def queue(export_app: FastAPI) -> GenerationQueue:
    return export_app.state.generation.queue


@pytest.fixture
def generations(engine: AsyncEngine) -> SqlGenerationRepository:
    return SqlGenerationRepository(engine)


def exports_url(conversation_id: uuid.UUID | str, export_id: str | None = None) -> str:
    base = f"{URL}/{conversation_id}/whole-film/exports"
    return base if export_id is None else f"{base}/{export_id}"


async def new_conversation(http: httpx.AsyncClient) -> uuid.UUID:
    created = await http.post(URL, json={"agentId": "director"})
    assert created.status_code == 201, created.text
    return uuid.UUID(created.json()["conversation"]["id"])


async def save_draft(
    http: httpx.AsyncClient, conversation_id: uuid.UUID, html: str, revision: int = 0
) -> int:
    saved = await http.put(
        f"{URL}/{conversation_id}/whole-film/draft", json={"revision": revision, "html": html}
    )
    assert saved.status_code == 200, saved.text
    return int(saved.json()["revision"])


def film_of(*takes: GenerationJob) -> str:
    return film_file(*((take.id, take.output.url or "") for take in takes))


async def latest(http: httpx.AsyncClient, conversation_id: uuid.UUID) -> dict[str, Any] | None:
    found = await http.get(exports_url(conversation_id, "latest"))
    assert found.status_code == 200, found.text
    return found.json()["export"]


async def started_export(
    http: httpx.AsyncClient, generations: SqlGenerationRepository, owner: uuid.UUID
) -> tuple[uuid.UUID, str, uuid.UUID]:
    conversation = await new_conversation(http)
    take = await finished(generations, owner, conversation, f"take-{uuid.uuid4()}")
    revision = await save_draft(http, conversation, film_of(take))
    started = await http.post(exports_url(conversation), json={"revision": revision})
    assert started.status_code == 202, started.text
    return conversation, started.json()["exportId"], take.id


async def record(generations: SqlGenerationRepository, export_id: str) -> GenerationJob:
    return await generations.get(uuid.UUID(export_id), owner=None)


async def submitted_hours_ago(engine: AsyncEngine, job_id: uuid.UUID, hours: int) -> None:
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "UPDATE iclip.generation_jobs"
                " SET submitted_at = now() - make_interval(hours => :hours) WHERE id = :id"
            ),
            {"id": job_id, "hours": hours},
        )


OWN_BUCKET_URL = f"{PUBLIC}/iclip/agent/videos/composed.mp4"

MUSIC_URL = "https://example.test/music.wav"


async def test_an_export_becomes_a_record_rendered_through_the_queue_and_kept_public(
    client: httpx.AsyncClient,
    pg_url: str,
    generations: SqlGenerationRepository,
    render: StubRender,
    queue: GenerationQueue,
) -> None:
    owner = uuid.UUID(await login_as_editor(client, pg_url))
    mine = await new_conversation(client)
    first = await finished(generations, owner, mine, "first")
    second = await complete(
        generations,
        await generations.create(
            make_job(video_request(), owner_user_id=owner, conversation_id=mine)
        ),
        OWN_BUCKET_URL,
    )
    music = await complete(
        generations,
        await generations.create(make_music(owner_user_id=owner, conversation_id=mine)),
        MUSIC_URL,
    )
    film = film_file(
        (second.id, OWN_BUCKET_URL),
        (first.id, "https://example.test/first.mp4"),
        audios=[(music.id, MUSIC_URL)],
    )
    revision = await save_draft(client, mine, film)
    marked = await client.put(f"{URL}/{mine}/completion", json={"completed": True})
    assert marked.status_code == 200, marked.text

    started = await client.post(exports_url(mine), json={"revision": revision})

    assert started.status_code == 202, started.text
    export_id = started.json()["exportId"]
    assert started.json() == {"exportId": export_id}
    pending = await record(generations, export_id)
    assert (pending.kind, pending.operation, pending.provider) == (
        KIND_WHOLE_FILM,
        OPERATION_RENDER,
        PROVIDER_NAME,
    )
    assert (pending.owner_user_id, pending.conversation_id) == (owner, mine)
    assert pending.request == WholeFilmRequest(
        revision=revision,
        videos=[
            WholeFilmVideoSource(job_id=second.id, url=OWN_BUCKET_URL),
            WholeFilmVideoSource(job_id=first.id, url="https://example.test/first.mp4"),
        ],
        audios=[WholeFilmAudioSource(job_id=music.id, url=MUSIC_URL)],
    ), "记录里只有版本号和用到的素材，没有成片文件"
    conversation = (await client.get(f"{URL}/{mine}")).json()["conversation"]
    assert conversation["completedAt"] is not None, "导出不是动手创作，不抹收尾标记"
    assert await latest(client, mine) == {
        "id": export_id,
        "status": "queued",
        "progress": None,
        "queuePosition": None,
        "error": None,
        "downloadUrl": None,
    }
    assert render.submitted == [], "受理时不调渲染服务"

    await queue.run_submit(export_id)

    (payload,) = render.submitted
    key = f"iclip/agent/whole-films/{export_id}.mp4"
    assert (payload["id"], payload["conversationId"], payload["film"]) == (
        export_id,
        str(mine),
        rewritten(film),
    ), "交给渲染服务的是存着的那份成片文件"
    assert payload["media"] == {
        OWN_BUCKET_URL: {"url": f"https://{INTERNAL_HOST}/iclip/agent/videos/composed.mp4"},
        "https://example.test/first.mp4": {"url": "https://example.test/first.mp4"},
        MUSIC_URL: {"url": MUSIC_URL},
    }, "文件里的地址（视频和音频）对到下载地址：本桶对象换成内网地址，别处的原样"
    upload = urlsplit(payload["upload"]["url"])
    assert (upload.netloc, upload.path) == (INTERNAL_HOST, f"/{key}")
    expires = datetime.fromtimestamp(int(parse_qs(upload.query)["Expires"][0]), UTC)
    assert timedelta(hours=5, minutes=59) < expires - datetime.now(UTC) <= timedelta(hours=6)
    assert payload["upload"]["headers"] == {"Content-Type": "video/mp4"}, "不带 ACL，随桶公共读"
    submitted = await record(generations, export_id)
    assert (submitted.status, submitted.provider_status) == (STATUS_SUBMITTED, "queued")

    render.advance(export_id, status="rendering", progress=0.4, queuePosition=None)
    assert await latest(client, mine) == {
        "id": export_id,
        "status": "rendering",
        "progress": 0.4,
        "queuePosition": None,
        "error": None,
        "downloadUrl": None,
    }
    with pytest.raises(StillRunning):
        await queue.run_poll(export_id)
    assert (await record(generations, export_id)).provider_status == "rendering"

    render.advance(export_id, status="done", progress=1.0)
    await queue.run_poll(export_id)

    done = await record(generations, export_id)
    assert (done.status, done.output.url) == (STATUS_COMPLETED, f"{PUBLIC}/{key}")
    assert await latest(client, mine) == {
        "id": export_id,
        "status": "done",
        "progress": None,
        "queuePosition": None,
        "error": None,
        "downloadUrl": f"{PUBLIC}/{key}",
    }


async def test_the_render_services_own_failure_and_a_lost_export_fail_the_record(
    client: httpx.AsyncClient,
    pg_url: str,
    generations: SqlGenerationRepository,
    render: StubRender,
    queue: GenerationQueue,
) -> None:
    owner = uuid.UUID(await login_as_editor(client, pg_url))
    failing, failed_id, _ = await started_export(client, generations, owner)
    lost, lost_id, _ = await started_export(client, generations, owner)
    await queue.run_submit(failed_id)
    await queue.run_submit(lost_id)

    error = {"code": "media-unreachable", "message": "取不到素材"}
    render.advance(failed_id, status="failed", queuePosition=None, error=error)
    del render.exports[lost_id]
    await queue.run_poll(failed_id)
    await queue.run_poll(lost_id)

    failed = await latest(client, failing)
    assert failed is not None
    assert (failed["status"], failed["error"], failed["downloadUrl"]) == ("failed", error, None)
    gone = await record(generations, lost_id)
    assert (gone.status, gone.error_code) == (STATUS_FAILED, "RENDER_LOST")
    lost_export = await latest(client, lost)
    assert lost_export is not None
    assert lost_export["status"] == "failed"
    assert lost_export["error"]["code"] == "RENDER_LOST"


async def test_a_refusal_or_an_outage_at_submit_fails_the_record_not_the_request(
    client: httpx.AsyncClient,
    pg_url: str,
    generations: SqlGenerationRepository,
    render: StubRender,
    queue: GenerationQueue,
) -> None:
    owner = uuid.UUID(await login_as_editor(client, pg_url))
    render.reject = ("media-host-not-allowed", "素材地址的主机不在允许范围")
    refused_in, refused_id, _ = await started_export(client, generations, owner)
    await queue.run_submit(refused_id)

    refused = await record(generations, refused_id)
    assert (refused.status, refused.error_code, refused.error_message) == (
        STATUS_FAILED,
        "RENDER_REJECTED",
        "素材地址的主机不在允许范围",
    )
    shown = await latest(client, refused_in)
    assert shown is not None
    assert shown["error"] == {
        "code": "RENDER_REJECTED",
        "message": "素材地址的主机不在允许范围",
    }

    render.reject = None
    _, down_id, _ = await started_export(client, generations, owner)
    render.down = True
    await queue.run_submit(down_id)

    down = await record(generations, down_id)
    assert (down.status, down.error_code) == (STATUS_FAILED, "RENDER_UNAVAILABLE")
    assert render.submitted == []


async def test_a_draft_changed_before_the_handover_fails_the_record(
    client: httpx.AsyncClient,
    pg_url: str,
    generations: SqlGenerationRepository,
    render: StubRender,
    queue: GenerationQueue,
) -> None:
    owner = uuid.UUID(await login_as_editor(client, pg_url))
    mine = await new_conversation(client)
    take = await finished(generations, owner, mine, "take")
    revision = await save_draft(client, mine, film_of(take))
    started = await client.post(exports_url(mine), json={"revision": revision})
    assert started.status_code == 202, started.text
    export_id = started.json()["exportId"]

    await save_draft(client, mine, film_file((take.id, take.output.url or "")), revision)
    await queue.run_submit(export_id)

    changed = await record(generations, export_id)
    assert (changed.status, changed.error_code) == (STATUS_FAILED, "FILM_CHANGED")
    assert render.submitted == [], "不拿新的一版顶替导出时的那一版"


async def test_a_render_outage_at_export_time_is_a_502_and_leaves_no_record(
    client: httpx.AsyncClient,
    pg_url: str,
    generations: SqlGenerationRepository,
    render: StubRender,
) -> None:
    owner = uuid.UUID(await login_as_editor(client, pg_url))
    mine = await new_conversation(client)
    take = await finished(generations, owner, mine, "take")
    revision = await save_draft(client, mine, film_of(take))

    render.down = True
    unreachable = await client.post(exports_url(mine), json={"revision": revision})
    render.down = False

    assert unreachable.status_code == 502, unreachable.text
    assert await latest(client, mine) is None


async def test_cancel_follows_where_the_record_is(
    client: httpx.AsyncClient,
    pg_url: str,
    generations: SqlGenerationRepository,
    render: StubRender,
    queue: GenerationQueue,
) -> None:
    owner = uuid.UUID(await login_as_editor(client, pg_url))

    waiting_in, waiting_id, _ = await started_export(client, generations, owner)
    assert (await client.delete(exports_url(waiting_in, waiting_id))).status_code == 204
    cancelled = await latest(client, waiting_in)
    assert cancelled is not None
    assert (cancelled["status"], cancelled["error"]) == ("cancelled", None)
    await queue.run_submit(waiting_id)
    assert render.submitted == [] and render.cancelled == [], "排队中取消不找渲染服务"
    assert (await record(generations, waiting_id)).error_code == "CANCELLED"

    handed_in, handed_id, _ = await started_export(client, generations, owner)
    await queue.run_submit(handed_id)
    render.down = True
    unreachable = await client.delete(exports_url(handed_in, handed_id))
    assert unreachable.status_code == 502, unreachable.text
    assert (await record(generations, handed_id)).status == STATUS_SUBMITTED
    render.down = False
    assert (await client.delete(exports_url(handed_in, handed_id))).status_code == 204
    assert render.cancelled == [handed_id]
    assert render.exports[handed_id]["status"] == "cancelled"
    handed = await record(generations, handed_id)
    assert (handed.status, handed.error_code) == (STATUS_FAILED, "CANCELLED")
    await queue.run_poll(handed_id)
    assert (await record(generations, handed_id)).error_code == "CANCELLED"

    forgotten_in, forgotten_id, _ = await started_export(client, generations, owner)
    await queue.run_submit(forgotten_id)
    del render.exports[forgotten_id]
    assert (await client.delete(exports_url(forgotten_in, forgotten_id))).status_code == 204
    assert (await record(generations, forgotten_id)).error_code == "CANCELLED"

    busy_in, busy_id, _ = await started_export(client, generations, owner)
    await generations.mark_submitting(uuid.UUID(busy_id))
    busy = await client.delete(exports_url(busy_in, busy_id))
    assert (busy.status_code, busy.json()) == (409, {"detail": "正在交给渲染服务，稍后再取消"})

    finished_in, finished_id, _ = await started_export(client, generations, owner)
    await queue.run_submit(finished_id)
    render.advance(finished_id, status="done", progress=1.0)
    await queue.run_poll(finished_id)
    assert (await client.delete(exports_url(finished_in, finished_id))).status_code == 204
    assert (await record(generations, finished_id)).status == STATUS_COMPLETED


async def test_the_render_lane_waits_six_hours_while_other_lanes_keep_the_default(
    client: httpx.AsyncClient,
    pg_url: str,
    engine: AsyncEngine,
    generations: SqlGenerationRepository,
    queue: GenerationQueue,
) -> None:
    owner = uuid.UUID(await login_as_editor(client, pg_url))
    _, export_id, _ = await started_export(client, generations, owner)
    await queue.run_submit(export_id)
    video = await generations.create(make_job(owner_user_id=owner, provider=VIDEO_PROVIDER_NAME))
    await generations.mark_submitting(video.id)
    await generations.mark_submitted(video.id, provider_task_id="v-1", provider_status="queued")

    await submitted_hours_ago(engine, uuid.UUID(export_id), 2)
    await submitted_hours_ago(engine, video.id, 2)
    with pytest.raises(StillRunning):
        await queue.run_poll(export_id)
    await queue.run_poll(str(video.id))

    assert (await record(generations, export_id)).status == STATUS_SUBMITTED
    timed_out_video = await generations.get(video.id, owner=None)
    assert (timed_out_video.status, timed_out_video.error_code) == (
        STATUS_FAILED,
        "PROVIDER_TIMEOUT",
    )

    await submitted_hours_ago(engine, uuid.UUID(export_id), 7)
    await queue.run_poll(export_id)

    timed_out = await record(generations, export_id)
    assert (timed_out.status, timed_out.error_code) == (STATUS_FAILED, "PROVIDER_TIMEOUT")
    assert timed_out.error_message is not None and "21600" in timed_out.error_message


def _whole_film(owner: uuid.UUID, conversation: uuid.UUID) -> GenerationJob:
    return make_job(
        WholeFilmRequest(revision=1, videos=[], audios=[]),
        owner_user_id=owner,
        conversation_id=conversation,
        provider=PROVIDER_NAME,
    )


async def test_latest_is_the_owners_newest_export_of_this_very_conversation(
    client: httpx.AsyncClient,
    pg_url: str,
    engine: AsyncEngine,
    generations: SqlGenerationRepository,
) -> None:
    owner = uuid.UUID(await login_as_editor(client, pg_url))
    mine, another = await new_conversation(client), await new_conversation(client)
    assert await latest(client, mine) is None

    own = await complete(
        generations, await generations.create(_whole_film(owner, mine)), f"{PUBLIC}/own.mp4"
    )
    fork = await open_conversation(SqlConversationRepository(engine), owner, forked_from=mine)
    stranger = await make_user(engine)
    await generations.create(_whole_film(stranger, mine))
    await generations.create(_whole_film(owner, another))

    found = await latest(client, mine)
    assert found is not None
    assert (found["id"], found["status"], found["downloadUrl"]) == (
        str(own.id),
        "done",
        f"{PUBLIC}/own.mp4",
    )
    assert await latest(client, fork.id) is None
    other = await latest(client, another)
    assert other is not None and other["id"] != str(own.id)


async def test_a_high_definition_version_of_an_export_is_not_the_latest_export(
    client: httpx.AsyncClient,
    pg_url: str,
    generations: SqlGenerationRepository,
) -> None:
    owner = uuid.UUID(await login_as_editor(client, pg_url))
    mine = await new_conversation(client)
    own = await complete(
        generations, await generations.create(_whole_film(owner, mine)), f"{PUBLIC}/own.mp4"
    )
    enhancement = await generations.create(make_enhancement(own, owner_user_id=owner))
    assert (enhancement.kind, enhancement.operation) == (KIND_VIDEO, OPERATION_ENHANCE)

    found = await latest(client, mine)
    assert found is not None and found["id"] == str(own.id)
    assert (await client.delete(exports_url(mine, str(enhancement.id)))).status_code == 404
    assert (await record(generations, str(enhancement.id))).error_code is None


async def test_exports_belong_to_the_owner_and_to_their_conversation(
    export_app: FastAPI,
    client: httpx.AsyncClient,
    pg_url: str,
    generations: SqlGenerationRepository,
) -> None:
    owner = uuid.UUID(await login_as_editor(client, pg_url))
    mine, export_id, _ = await started_export(client, generations, owner)
    another = await new_conversation(client)
    revision = 1

    async with make_client(export_app) as stranger, make_client(export_app) as governor:
        await login_as_editor(stranger, pg_url, username="mallory")
        await register_and_login(governor, username="gov", email="gov@example.com")
        await set_roles_in_db(pg_url, "gov@example.com", ["root"])
        for http, status in ((stranger, 404), (governor, 403)):
            assert (
                await http.post(exports_url(mine), json={"revision": revision})
            ).status_code == status
            assert (await http.get(exports_url(mine, "latest"))).status_code == status
            assert (await http.delete(exports_url(mine, export_id))).status_code == status

    elsewhere = await client.delete(exports_url(another, export_id))
    assert elsewhere.status_code == 404
    assert (await client.delete(exports_url(mine, str(uuid.uuid4())))).status_code == 404
    assert (await record(generations, export_id)).error_code is None


async def test_only_the_saved_revision_of_a_film_that_is_not_empty_is_exported(
    client: httpx.AsyncClient,
    pg_url: str,
    generations: SqlGenerationRepository,
) -> None:
    owner = uuid.UUID(await login_as_editor(client, pg_url))
    mine = await new_conversation(client)

    assert (await client.post(exports_url(mine), json={"revision": 1})).status_code == 409
    nothing = await client.post(exports_url(mine), json={"revision": 0})
    assert nothing.status_code == 422, nothing.text

    take = await finished(generations, owner, mine, "take")
    revision = await save_draft(client, mine, film_of(take))
    for stale in (0, revision + 1):
        assert (await client.post(exports_url(mine), json={"revision": stale})).status_code == 409

    revision = await save_draft(client, mine, film_file(duration_ms=0), revision)
    empty = await client.post(exports_url(mine), json={"revision": revision})
    assert (empty.status_code, empty.json()) == (
        422,
        {"detail": "成片还是空的，导不出成片"},
    )
    assert await latest(client, mine) is None

    # 只有组件块的成片没有素材，照样能导出
    revision = await save_draft(client, mine, film_file(duration_ms=3000), revision)
    started = await client.post(exports_url(mine), json={"revision": revision})
    assert started.status_code == 202, started.text
    assert (await latest(client, mine) or {}).get("id") == started.json()["exportId"]


@pytest.fixture
async def unrendered_app(
    base_env: None, engine: AsyncEngine, monkeypatch: pytest.MonkeyPatch, render: StubRender
) -> FastAPI:
    return await build_whole_film_app(monkeypatch, engine, render, render_url=None)


async def test_exports_are_unavailable_without_a_render_service(
    unrendered_app: FastAPI, pg_url: str
) -> None:
    async with make_client(unrendered_app) as http:
        await login_as_editor(http, pg_url)
        mine = await new_conversation(http)
        started = await http.post(exports_url(mine), json={"revision": 0})
        read = await http.get(exports_url(mine, "latest"))
        cancelled = await http.delete(exports_url(mine, str(uuid.uuid4())))

    assert (started.status_code, started.json()) == (422, {"detail": "成片导出没有开通"})
    assert read.status_code == 422
    assert cancelled.status_code == 422
