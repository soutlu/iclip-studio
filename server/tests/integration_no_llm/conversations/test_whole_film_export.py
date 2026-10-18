"""整片导出端点：按存着的草稿交给渲染服务、转问进度、签下载地址与取消，渲染服务用桩。

草稿经 HTTP 存，成片、音乐与字幕记录经生成仓储直接落库；对象存储与签名都用替身。"""

from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import quote

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.app.bootstrap import build_app
from iclip.domains.generation.infra_sql import SqlGenerationRepository
from iclip.domains.generation.models import GenerationJob
from iclip.domains.generation.schemas import SubtitleSentence, SubtitleWord
from iclip.platform.db.engine import build_engine
from tests.helpers.app import make_client, make_runtime_config
from tests.helpers.auth import login_as_editor, register_and_login, set_roles_in_db
from tests.helpers.fork_lineage import finished
from tests.helpers.generation import MemoryObjectStore, make_music, make_subtitle
from tests.helpers.pg import connected, reset_database
from tests.helpers.render import FakeExportSigner, StubRender
from tests.helpers.whole_film import component_clip, draft_document, video_clip

URL = "/conversations"

OSS_ENVS = {
    "OSS_BUCKET": "iclip-test",
    "OSS_ENDPOINT": "oss-ap-southeast-1.aliyuncs.com",
    "OSS_ACCESS_KEY_ID": "ak",
    "OSS_ACCESS_KEY_SECRET": "sk",
    "OSS_PUBLIC_URL_BASE": "https://cdn.example.test",
}


@pytest.fixture
def render() -> StubRender:
    return StubRender()


@pytest.fixture
def signer() -> FakeExportSigner:
    return FakeExportSigner()


async def _app(
    monkeypatch: pytest.MonkeyPatch,
    migrated_pg: str,
    render: StubRender,
    signer: FakeExportSigner,
    *,
    render_url: str | None,
) -> AsyncGenerator[FastAPI]:
    for name, value in OSS_ENVS.items():
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
            make_runtime_config(),
            engine=engine,
            object_store=MemoryObjectStore(),
            export_objects=signer,
            whole_film_render_transport=render.transport(),
        )
    finally:
        await engine.dispose()


@pytest.fixture
async def export_app(
    base_env: None,
    migrated_pg: str,
    monkeypatch: pytest.MonkeyPatch,
    render: StubRender,
    signer: FakeExportSigner,
) -> AsyncGenerator[FastAPI]:
    async for app in _app(
        monkeypatch, migrated_pg, render, signer, render_url="http://render:8080"
    ):
        yield app


@pytest.fixture
async def client(export_app: FastAPI) -> AsyncGenerator[httpx.AsyncClient]:
    async with make_client(export_app) as http:
        yield http


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
        output_url="https://cdn.example.test/iclip/agent/generated-music/m.m4a",
        provider_status="succeeded",
        duration_ms=30_000,
    )
    return str(music.id)


async def test_an_export_is_queued_polled_and_handed_back_as_a_signed_download(
    client: httpx.AsyncClient,
    pg_url: str,
    generations: SqlGenerationRepository,
    render: StubRender,
    signer: FakeExportSigner,
) -> None:
    """渲染服务收到草稿原样、各成片的原片地址、音乐、有字幕的那条成片的逐词字幕与上传地址；
    排队时没有下载地址，完成后带 1 小时的下载地址。答复的成片按在画面轨里第一次出现的先后。"""

    owner = uuid.UUID(await login_as_editor(client, pg_url))
    mine = await new_conversation(client)
    first = await finished(generations, owner, mine, "first")
    second = await finished(generations, owner, mine, "second")
    subtitle = await _transcribed(generations, first)
    stale = await generations.create(make_subtitle(first))
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

    started = await client.post(exports_url(mine), json={"revision": revision})

    assert started.status_code == 202, started.text
    export_id = started.json()["exportId"]
    assert started.json()["sourceJobIds"] == [str(second.id), str(first.id)]
    (payload,) = render.submitted
    key = f"iclip/agent/whole-film-exports/{export_id}.mp4"
    assert (payload["id"], payload["conversationId"], payload["document"]) == (
        export_id,
        str(mine),
        document,
    )
    assert payload["media"]["videos"] == {
        str(second.id): {"url": "https://example.test/second.mp4"},
        str(first.id): {"url": "https://example.test/first.mp4"},
    }
    assert payload["media"]["music"] == {
        "url": "https://cdn.example.test/iclip/agent/generated-music/m.m4a"
    }
    assert payload["media"]["subtitles"] == {
        str(first.id): {
            "subtitleJobId": str(subtitle.id),
            "sentences": [SENTENCE.model_dump(mode="json", by_alias=True)],
        }
    }, "没完成的字幕记录不算，没字幕的成片不在里面"
    assert stale.id != subtitle.id
    assert payload["media"]["subtitles"][str(first.id)]["sentences"][0]["words"][1] == {
        "startMs": 400,
        "endMs": 900,
        "text": "轻",
        "punctuation": "。",
    }
    assert payload["upload"] == {
        "url": f"https://internal.oss.test/{key}?put",
        "headers": {"Content-Type": "video/mp4", "x-oss-object-acl": "private"},
    }
    assert signer.puts == [(key, "video/mp4", 6 * 3600)]

    queued = await client.get(exports_url(mine, export_id))
    assert queued.status_code == 200, queued.text
    assert queued.json() == {
        "status": "queued",
        "progress": 0.0,
        "queuePosition": 0,
        "error": None,
        "downloadUrl": None,
        "expiresAt": None,
    }

    render.advance(export_id, status="done", progress=1.0, queuePosition=None)
    done = (await client.get(exports_url(mine, export_id))).json()
    ((signed_key, filename, expires),) = signer.downloads
    assert (signed_key, expires) == (key, 3600)
    assert filename.startswith("整片-") and filename.endswith(".mp4") and len(filename) == 20
    assert done["status"] == "done"
    assert done["downloadUrl"] == f"https://public.oss.test/{key}?name={quote(filename)}"
    left = datetime.fromisoformat(done["expiresAt"]) - datetime.now(UTC)
    assert timedelta(minutes=59) < left <= timedelta(hours=1)


async def test_a_failed_export_reports_the_render_reason(
    client: httpx.AsyncClient, pg_url: str, generations: SqlGenerationRepository, render: StubRender
) -> None:
    owner = uuid.UUID(await login_as_editor(client, pg_url))
    mine = await new_conversation(client)
    take = await finished(generations, owner, mine, "take")
    revision = await save_draft(client, mine, draft_document(source_job_id=take.id))
    export_id = (await client.post(exports_url(mine), json={"revision": revision})).json()[
        "exportId"
    ]

    error = {"code": "media-unreachable", "message": "取不到素材"}
    render.advance(export_id, status="failed", queuePosition=None, error=error)
    failed = (await client.get(exports_url(mine, export_id))).json()

    assert (failed["status"], failed["error"], failed["downloadUrl"]) == ("failed", error, None)


async def test_only_the_saved_revision_with_something_on_layer0_is_exported(
    client: httpx.AsyncClient, pg_url: str, generations: SqlGenerationRepository, render: StubRender
) -> None:
    """版本号不是存着的那一版 409；还没有草稿、画面轨是空的都导不出 422，都不交给渲染服务。
    画面轨只有组件段也能导，用到的成片为空。"""

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
    assert render.submitted == []

    components_only = draft_document(layer0=[component_clip("c", start=0, duration=2000)])
    revision = await save_draft(client, mine, components_only, revision)
    started = await client.post(exports_url(mine), json={"revision": revision})
    assert started.status_code == 202, started.text
    assert started.json()["sourceJobIds"] == []
    (payload,) = render.submitted
    assert (payload["document"], payload["media"]["videos"]) == (components_only, {})


async def test_exports_belong_to_the_owner_and_to_their_conversation(
    export_app: FastAPI,
    client: httpx.AsyncClient,
    pg_url: str,
    generations: SqlGenerationRepository,
    render: StubRender,
) -> None:
    """读不到这段对话 404，治理者 403；同一个人的另一段对话拿这个导出 id 读、取消都是 404，
    导出照旧。"""

    owner = uuid.UUID(await login_as_editor(client, pg_url))
    mine, another = await new_conversation(client), await new_conversation(client)
    take = await finished(generations, owner, mine, "take")
    revision = await save_draft(client, mine, draft_document(source_job_id=take.id))
    export_id = (await client.post(exports_url(mine), json={"revision": revision})).json()[
        "exportId"
    ]

    async with make_client(export_app) as stranger, make_client(export_app) as governor:
        await login_as_editor(stranger, pg_url, username="mallory")
        await register_and_login(governor, username="gov", email="gov@example.com")
        await set_roles_in_db(pg_url, "gov@example.com", ["root"])
        for http, status in ((stranger, 404), (governor, 403)):
            assert (
                await http.post(exports_url(mine), json={"revision": revision})
            ).status_code == status
            assert (await http.get(exports_url(mine, export_id))).status_code == status
            assert (await http.delete(exports_url(mine, export_id))).status_code == status

    elsewhere = await client.get(exports_url(another, export_id))
    assert elsewhere.status_code == 404
    assert (await client.delete(exports_url(another, export_id))).status_code == 404
    assert render.exports[export_id]["status"] == "queued"
    assert len(render.submitted) == 1


async def test_cancel_and_an_export_the_render_service_no_longer_knows(
    client: httpx.AsyncClient, pg_url: str, generations: SqlGenerationRepository, render: StubRender
) -> None:
    """取消答 204；渲染服务查不到的导出（过期、重启过）读与取消都是 404，提示重新导出。"""

    owner = uuid.UUID(await login_as_editor(client, pg_url))
    mine = await new_conversation(client)
    take = await finished(generations, owner, mine, "take")
    revision = await save_draft(client, mine, draft_document(source_job_id=take.id))
    export_id = (await client.post(exports_url(mine), json={"revision": revision})).json()[
        "exportId"
    ]

    assert (await client.delete(exports_url(mine, export_id))).status_code == 204
    assert (await client.get(exports_url(mine, export_id))).json()["status"] == "cancelled"
    assert (await client.delete(exports_url(mine, export_id))).status_code == 204

    render.exports.clear()
    gone = await client.get(exports_url(mine, export_id))
    assert (gone.status_code, gone.json()) == (404, {"detail": "导出已中断，请重新导出"})
    assert (await client.delete(exports_url(mine, export_id))).status_code == 404


async def test_the_render_services_refusal_and_outage_reach_the_caller(
    client: httpx.AsyncClient, pg_url: str, generations: SqlGenerationRepository, render: StubRender
) -> None:
    """渲染服务拒收（400）答 422，带它的那句话；连不上、5xx 都答 502。"""

    owner = uuid.UUID(await login_as_editor(client, pg_url))
    mine = await new_conversation(client)
    take = await finished(generations, owner, mine, "take")
    revision = await save_draft(client, mine, draft_document(source_job_id=take.id))

    render.reject = ("unknown-component", "组件 brand-intro 不在组件库里")
    refused = await client.post(exports_url(mine), json={"revision": revision})
    assert (refused.status_code, refused.json()) == (
        422,
        {"detail": "组件 brand-intro 不在组件库里"},
    )

    render.reject = None
    export_id = (await client.post(exports_url(mine), json={"revision": revision})).json()[
        "exportId"
    ]
    render.down = True
    assert (await client.post(exports_url(mine), json={"revision": revision})).status_code == 502
    assert (await client.get(exports_url(mine, export_id))).status_code == 502
    render.down, render.server_error = False, True
    assert (await client.get(exports_url(mine, export_id))).status_code == 502
    assert (await client.delete(exports_url(mine, export_id))).status_code == 502


@pytest.fixture
async def unrendered_app(
    base_env: None,
    migrated_pg: str,
    monkeypatch: pytest.MonkeyPatch,
    render: StubRender,
    signer: FakeExportSigner,
) -> AsyncGenerator[FastAPI]:
    async for app in _app(monkeypatch, migrated_pg, render, signer, render_url=None):
        yield app


async def test_exports_are_unavailable_without_a_render_service(
    unrendered_app: FastAPI, pg_url: str
) -> None:
    async with make_client(unrendered_app) as http:
        await login_as_editor(http, pg_url)
        mine = await new_conversation(http)
        started = await http.post(exports_url(mine), json={"revision": 0})
        read = await http.get(exports_url(mine, str(uuid.uuid4())))

    assert (started.status_code, started.json()) == (422, {"detail": "整片导出没有开通"})
    assert read.status_code == 422
