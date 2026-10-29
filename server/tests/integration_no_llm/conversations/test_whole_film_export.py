"""成片导出：每次导出是一条成片生成记录，由生成队列交给渲染服务；端点受理、读最新一次与取消。

草稿经 HTTP 存，素材片、音乐与字幕记录经生成仓储直接落库；渲染服务用桩，队列不起 worker，测试直接
调应用装配好的那个生成队列的 ``run_submit`` / ``run_poll``。对象存储按环境变量装真的 OSS 适配器
（带内网 endpoint），签名与地址换算都在本地算，不发请求。"""

from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from fastapi import FastAPI
from procrastinate.testing import InMemoryConnector
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.app.bootstrap import build_app
from iclip.domains.conversations.infra_sql import SqlConversationRepository
from iclip.domains.generation.infra_sql import SqlGenerationRepository
from iclip.domains.generation.models import (
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_SUBMITTED,
    GenerationJob,
    GenerationOutput,
)
from iclip.domains.generation.queue import GenerationQueue, StillRunning
from iclip.domains.generation.render import PROVIDER_NAME
from iclip.domains.generation.schemas import (
    KIND_VIDEO,
    KIND_WHOLE_FILM,
    OPERATION_ENHANCE,
    OPERATION_RENDER,
    SubtitleSentence,
    SubtitleWord,
    WholeFilmRequest,
)
from iclip.domains.generation.video import PROVIDER_NAME as VIDEO_PROVIDER_NAME
from iclip.platform.db.engine import build_engine
from iclip.platform.media.codec import SOFTWARE
from tests.helpers.app import make_client
from tests.helpers.auth import login_as_editor, register_and_login, set_roles_in_db
from tests.helpers.fork_lineage import complete, finished, make_user, open_conversation
from tests.helpers.generation import (
    MEDIA_ENVS,
    config_with_media,
    make_enhancement,
    make_job,
    make_music,
    make_subtitle,
)
from tests.helpers.pg import connected, reset_database
from tests.helpers.render import StubRender
from tests.helpers.whole_film import component_clip, draft_document, video_clip

URL = "/conversations"

PUBLIC = "https://cdn.example.test"
"""``MEDIA_ENVS`` 里的 ``OSS_PUBLIC_URL_BASE``。"""

INTERNAL_HOST = "iclip-test.oss-ap-southeast-1-internal.aliyuncs.com"
"""``OSS_BUCKET`` 加内网 endpoint 的 host：本桶对象交给渲染服务时换成它。"""

RENDER_ENVS = {
    **MEDIA_ENVS,
    "OSS_INTERNAL_ENDPOINT": "https://oss-ap-southeast-1-internal.aliyuncs.com",
}


@pytest.fixture
def render() -> StubRender:
    return StubRender()


async def _app(
    monkeypatch: pytest.MonkeyPatch,
    migrated_pg: str,
    render: StubRender,
    *,
    render_url: str | None,
) -> AsyncGenerator[FastAPI]:
    for name, value in RENDER_ENVS.items():
        monkeypatch.setenv(name, value)
    if render_url is None:
        monkeypatch.delenv("WHOLE_FILM_RENDER_URL", raising=False)
    else:
        monkeypatch.setenv("WHOLE_FILM_RENDER_URL", render_url)
    async with connected(migrated_pg) as conn:
        await reset_database(conn)
    engine = build_engine(migrated_pg)
    try:
        yield build_app(
            config_with_media(),
            engine=engine,
            queue_connector=InMemoryConnector(),
            media_codec=SOFTWARE,
            whole_film_render_transport=render.transport(),
        )
    finally:
        await engine.dispose()


@pytest.fixture
async def export_app(
    base_env: None, migrated_pg: str, monkeypatch: pytest.MonkeyPatch, render: StubRender
) -> AsyncGenerator[FastAPI]:
    async for app in _app(monkeypatch, migrated_pg, render, render_url="http://render:8080"):
        yield app


@pytest.fixture
async def client(export_app: FastAPI) -> AsyncGenerator[httpx.AsyncClient]:
    async with make_client(export_app) as http:
        yield http


@pytest.fixture
def queue(export_app: FastAPI) -> GenerationQueue:
    """应用装配好的那个生成队列：端点受理的记录排给它。"""

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
    http: httpx.AsyncClient, conversation_id: uuid.UUID, document: dict[str, Any], revision: int = 0
) -> int:
    saved = await http.put(
        f"{URL}/{conversation_id}/whole-film/draft",
        json={"revision": revision, "document": document},
    )
    assert saved.status_code == 200, saved.text
    return int(saved.json()["revision"])


async def latest(http: httpx.AsyncClient, conversation_id: uuid.UUID) -> dict[str, Any] | None:
    found = await http.get(exports_url(conversation_id, "latest"))
    assert found.status_code == 200, found.text
    return found.json()["export"]


async def started_export(
    http: httpx.AsyncClient, generations: SqlGenerationRepository, owner: uuid.UUID
) -> tuple[uuid.UUID, str, uuid.UUID]:
    """新开一段对话、存一份用一条素材片的草稿并导出；给出对话、导出 id 与那条素材片。"""

    conversation = await new_conversation(http)
    take = await finished(generations, owner, conversation, f"take-{uuid.uuid4()}")
    revision = await save_draft(http, conversation, draft_document(source_job_id=take.id))
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


SENTENCE = SubtitleSentence(
    start_ms=0,
    end_ms=900,
    text="真轻",
    speaker=None,
    words=(
        SubtitleWord(start_ms=0, end_ms=400, text="真"),
        SubtitleWord(start_ms=400, end_ms=900, text="轻", punctuation="。"),
    ),
)

MUSIC_URL = f"{PUBLIC}/iclip/agent/generated-music/m.m4a"


async def _transcribed(repo: SqlGenerationRepository, take: GenerationJob) -> GenerationJob:
    subtitle = await repo.create(make_subtitle(take))
    done = await repo.mark_transcribed(
        subtitle.id, sentences=(SENTENCE,), provider_status="succeeded", provider_task_id="asr"
    )
    assert done is not None
    return done


async def _music(repo: SqlGenerationRepository, owner: uuid.UUID, conversation: uuid.UUID) -> str:
    music = await repo.create(make_music(owner_user_id=owner, conversation_id=conversation))
    await repo.mark_completed(
        music.id,
        output=GenerationOutput(url=MUSIC_URL, duration_ms=30_000),
        provider_status="succeeded",
    )
    return str(music.id)


async def test_an_export_becomes_a_record_rendered_through_the_queue_and_kept_public(
    client: httpx.AsyncClient,
    pg_url: str,
    generations: SqlGenerationRepository,
    render: StubRender,
    queue: GenerationQueue,
) -> None:
    """受理即记一条成片生成记录；队列把草稿原样、各素材片与音乐（本桶对象换成内网地址）、有字幕的那条
    素材片的逐词字幕与签好的上传地址交给渲染服务；渲染中读得到它的进度，完成后记录带上成片的公开地址。
    导出不抹对话的收尾标记。"""

    owner = uuid.UUID(await login_as_editor(client, pg_url))
    mine = await new_conversation(client)
    first = await finished(generations, owner, mine, "first")
    second = await finished(generations, owner, mine, "second")
    subtitle = await _transcribed(generations, first)
    await generations.create(make_subtitle(first))
    music = await _music(generations, owner, mine)
    document = draft_document(
        layer0=[
            video_clip("a", start=0, duration=2000, source_job_id=second.id),
            video_clip("b", start=2000, duration=1000, source_job_id=first.id),
            video_clip("c", start=3000, duration=1000, source_job_id=second.id),
        ],
        music={"jobId": music, "offset": 0, "volume": 0.8},
    )
    revision = await save_draft(client, mine, document)
    marked = await client.put(f"{URL}/{mine}/completion", json={"completed": True})
    assert marked.status_code == 200, marked.text

    started = await client.post(exports_url(mine), json={"revision": revision})

    assert started.status_code == 202, started.text
    export_id = started.json()["exportId"]
    sources = [str(second.id), str(first.id)]
    assert started.json()["sourceJobIds"] == sources
    pending = await record(generations, export_id)
    assert (pending.kind, pending.operation, pending.provider) == (
        KIND_WHOLE_FILM,
        OPERATION_RENDER,
        PROVIDER_NAME,
    )
    assert (pending.owner_user_id, pending.conversation_id) == (owner, mine)
    assert isinstance(pending.request, WholeFilmRequest)
    assert (pending.request.revision, pending.request.document) == (revision, document)
    conversation = (await client.get(f"{URL}/{mine}")).json()["conversation"]
    assert conversation["completedAt"] is not None, "导出不是动手创作，不抹收尾标记"
    assert await latest(client, mine) == {
        "id": export_id,
        "status": "queued",
        "progress": None,
        "queuePosition": None,
        "error": None,
        "downloadUrl": None,
        "sourceJobIds": sources,
    }
    assert render.submitted == [], "受理时不调渲染服务"

    await queue.run_submit(export_id)

    (payload,) = render.submitted
    key = f"iclip/agent/whole-films/{export_id}.mp4"
    assert (payload["id"], payload["conversationId"], payload["document"]) == (
        export_id,
        str(mine),
        document,
    )
    assert list(payload["media"]["videos"]) == sources
    assert payload["media"]["videos"] == {
        str(second.id): {"url": "https://example.test/second.mp4"},
        str(first.id): {"url": "https://example.test/first.mp4"},
    }, "上游发布的出片地址原样"
    assert payload["media"]["music"] == {
        "url": f"https://{INTERNAL_HOST}/iclip/agent/generated-music/m.m4a"
    }, "本桶对象换成内网地址"
    assert payload["media"]["subtitles"] == {
        str(first.id): {
            "subtitleJobId": str(subtitle.id),
            "sentences": [SENTENCE.model_dump(mode="json", by_alias=True)],
        }
    }, "没完成的字幕记录不算，没字幕的素材片不在里面"
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
        "sourceJobIds": sources,
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
        "sourceJobIds": sources,
    }


async def test_the_render_services_own_failure_and_a_lost_export_fail_the_record(
    client: httpx.AsyncClient,
    pg_url: str,
    generations: SqlGenerationRepository,
    render: StubRender,
    queue: GenerationQueue,
) -> None:
    """渲染服务报失败，记录照它的错误码与原因失败；它查不到这次导出（重启过）记 ``RENDER_LOST``。"""

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
    """渲染服务不收（400）或连不上都不影响受理（202）；队列提交时记录失败，前者带它的那句话。"""

    owner = uuid.UUID(await login_as_editor(client, pg_url))
    render.reject = ("unknown-component", "组件 brand-intro 不在组件库里")
    refused_in, refused_id, _ = await started_export(client, generations, owner)
    await queue.run_submit(refused_id)

    refused = await record(generations, refused_id)
    assert (refused.status, refused.error_code, refused.error_message) == (
        STATUS_FAILED,
        "RENDER_REJECTED",
        "组件 brand-intro 不在组件库里",
    )
    shown = await latest(client, refused_in)
    assert shown is not None
    assert shown["error"] == {
        "code": "RENDER_REJECTED",
        "message": "组件 brand-intro 不在组件库里",
    }

    render.reject, render.down = None, True
    _, down_id, _ = await started_export(client, generations, owner)
    await queue.run_submit(down_id)

    down = await record(generations, down_id)
    assert (down.status, down.error_code) == (STATUS_FAILED, "RENDER_UNAVAILABLE")
    assert render.submitted == []


async def test_cancel_follows_where_the_record_is(
    client: httpx.AsyncClient,
    pg_url: str,
    generations: SqlGenerationRepository,
    render: StubRender,
    queue: GenerationQueue,
) -> None:
    """排队中直接记取消、之后也不再交给渲染服务；已交出去的先让渲染服务取消再记；正在交给渲染服务
    答 409；渲染服务连不上答 502、记录不动；已结束的答 204、不改。"""

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
    """渲染服务一次只渲染一个，导出交出去 2 小时还在排队不算超时，7 小时才按超时收尾；视频那条
    lane 照旧 1 小时。"""

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
        WholeFilmRequest(
            revision=1, document=draft_document(), videos=[], music=None, subtitles=[]
        ),
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
    """还没导出过是 null；之后别人记在这段对话上的、自己在别的对话里的都不算；分叉出来的对话不继承
    源对话的导出。"""

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
    """给导出做的高清版是视频 / 超分，不挂对话：最新一次导出照旧是那次导出，也取消不了它。"""

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
    """读不到这段对话 404，治理者 403；同一个人的另一段对话拿这个导出 id 取消是 404，导出照旧。"""

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


async def test_only_the_saved_revision_with_something_on_layer0_is_exported(
    client: httpx.AsyncClient,
    pg_url: str,
    generations: SqlGenerationRepository,
    render: StubRender,
    queue: GenerationQueue,
) -> None:
    """版本号不是存着的那一版 409；还没有草稿、画面轨是空的都导不出 422，都不记导出。
    画面轨只有组件段也能导，用到的素材片为空。"""

    owner = uuid.UUID(await login_as_editor(client, pg_url))
    mine = await new_conversation(client)

    assert (await client.post(exports_url(mine), json={"revision": 1})).status_code == 409
    nothing = await client.post(exports_url(mine), json={"revision": 0})
    assert nothing.status_code == 422, nothing.text

    take = await finished(generations, owner, mine, "take")
    revision = await save_draft(client, mine, draft_document(source_job_id=take.id))
    for stale in (0, revision + 1):
        assert (await client.post(exports_url(mine), json={"revision": stale})).status_code == 409

    revision = await save_draft(client, mine, draft_document(layer0=[]), revision)
    empty = await client.post(exports_url(mine), json={"revision": revision})
    assert empty.status_code == 422, empty.text
    assert await latest(client, mine) is None

    components_only = draft_document(layer0=[component_clip("c", start=0, duration=2000)])
    revision = await save_draft(client, mine, components_only, revision)
    started = await client.post(exports_url(mine), json={"revision": revision})
    assert started.status_code == 202, started.text
    assert started.json()["sourceJobIds"] == []
    await queue.run_submit(started.json()["exportId"])
    (payload,) = render.submitted
    assert (payload["document"], payload["media"]["videos"]) == (components_only, {})


@pytest.fixture
async def unrendered_app(
    base_env: None, migrated_pg: str, monkeypatch: pytest.MonkeyPatch, render: StubRender
) -> AsyncGenerator[FastAPI]:
    async for app in _app(monkeypatch, migrated_pg, render, render_url=None):
        yield app


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
