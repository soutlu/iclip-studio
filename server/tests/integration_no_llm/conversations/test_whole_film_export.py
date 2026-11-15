from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator
from typing import Any

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
from iclip.domains.generation.render import EXPORT_PAUSED, EXPORT_PAUSED_MESSAGE, PROVIDER_NAME
from iclip.domains.generation.schemas import KIND_VIDEO, OPERATION_ENHANCE, WholeFilmRequest
from iclip.domains.generation.video import PROVIDER_NAME as VIDEO_PROVIDER_NAME
from tests.helpers.app import make_client
from tests.helpers.auth import login_as_editor, register_and_login, set_roles_in_db
from tests.helpers.fork_lineage import complete, make_user, open_conversation
from tests.helpers.generation import make_enhancement, make_job
from tests.helpers.render import StubRender
from tests.helpers.whole_film import build_whole_film_app

URL = "/conversations"

PUBLIC = "https://cdn.example.test"

PAUSED = {"detail": "导出功能正在调整，无法导出；请稍后再试"}


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


async def latest(http: httpx.AsyncClient, conversation_id: uuid.UUID) -> dict[str, Any] | None:
    found = await http.get(exports_url(conversation_id, "latest"))
    assert found.status_code == 200, found.text
    return found.json()["export"]


def _whole_film(owner: uuid.UUID, conversation: uuid.UUID) -> GenerationJob:
    return make_job(
        WholeFilmRequest(revision=1, videos=[], audios=[]),
        owner_user_id=owner,
        conversation_id=conversation,
        provider=PROVIDER_NAME,
    )


async def queued_export(
    http: httpx.AsyncClient, generations: SqlGenerationRepository, owner: uuid.UUID
) -> tuple[uuid.UUID, str]:
    """发起导出暂停之前排进队列、还没交给渲染服务的一次导出。"""

    conversation = await new_conversation(http)
    job = await generations.create(_whole_film(owner, conversation))
    return conversation, str(job.id)


async def handed_over_export(
    http: httpx.AsyncClient,
    generations: SqlGenerationRepository,
    render: StubRender,
    owner: uuid.UUID,
) -> tuple[uuid.UUID, str]:
    """发起导出暂停之前已经交给渲染服务、正在排队的一次导出。"""

    conversation, export_id = await queued_export(http, generations, owner)
    await generations.mark_submitting(uuid.UUID(export_id))
    await generations.mark_submitted(
        uuid.UUID(export_id), provider_task_id=export_id, provider_status="queued"
    )
    render.accept(export_id, str(conversation))
    return conversation, export_id


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


async def test_starting_an_export_is_paused_and_leaves_no_record(
    client: httpx.AsyncClient, pg_url: str, render: StubRender
) -> None:
    await login_as_editor(client, pg_url)
    mine = await new_conversation(client)

    for body in (None, {"revision": 1}):
        started = await client.post(exports_url(mine), json=body)
        assert (started.status_code, started.json()) == (422, PAUSED)

    assert await latest(client, mine) is None
    assert render.requests == [], "不找渲染服务"


async def test_a_record_queued_before_the_pause_fails_without_reaching_the_render_service(
    client: httpx.AsyncClient,
    pg_url: str,
    generations: SqlGenerationRepository,
    render: StubRender,
    queue: GenerationQueue,
) -> None:
    owner = uuid.UUID(await login_as_editor(client, pg_url))
    conversation, export_id = await queued_export(client, generations, owner)

    await queue.run_submit(export_id)

    failed = await record(generations, export_id)
    assert (failed.status, failed.error_code, failed.error_message) == (
        STATUS_FAILED,
        EXPORT_PAUSED,
        EXPORT_PAUSED_MESSAGE,
    )
    assert render.requests == []
    shown = await latest(client, conversation)
    assert shown is not None
    assert (shown["status"], shown["error"]) == (
        "failed",
        {"code": EXPORT_PAUSED, "message": EXPORT_PAUSED_MESSAGE},
    )


async def test_an_export_handed_over_before_the_pause_keeps_reporting_until_it_is_done(
    client: httpx.AsyncClient,
    pg_url: str,
    generations: SqlGenerationRepository,
    render: StubRender,
    queue: GenerationQueue,
) -> None:
    owner = uuid.UUID(await login_as_editor(client, pg_url))
    mine, export_id = await handed_over_export(client, generations, render, owner)

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

    key = f"iclip/agent/whole-films/{export_id}.mp4"
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
    failing, failed_id = await handed_over_export(client, generations, render, owner)
    lost, lost_id = await handed_over_export(client, generations, render, owner)

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


async def test_cancel_follows_where_the_record_is(
    client: httpx.AsyncClient,
    pg_url: str,
    generations: SqlGenerationRepository,
    render: StubRender,
    queue: GenerationQueue,
) -> None:
    owner = uuid.UUID(await login_as_editor(client, pg_url))

    waiting_in, waiting_id = await queued_export(client, generations, owner)
    assert (await client.delete(exports_url(waiting_in, waiting_id))).status_code == 204
    cancelled = await latest(client, waiting_in)
    assert cancelled is not None
    assert (cancelled["status"], cancelled["error"]) == ("cancelled", None)
    await queue.run_submit(waiting_id)
    assert render.cancelled == [], "排队中取消不找渲染服务"
    assert (await record(generations, waiting_id)).error_code == "CANCELLED"

    handed_in, handed_id = await handed_over_export(client, generations, render, owner)
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

    forgotten_in, forgotten_id = await handed_over_export(client, generations, render, owner)
    del render.exports[forgotten_id]
    assert (await client.delete(exports_url(forgotten_in, forgotten_id))).status_code == 204
    assert (await record(generations, forgotten_id)).error_code == "CANCELLED"

    busy_in, busy_id = await queued_export(client, generations, owner)
    await generations.mark_submitting(uuid.UUID(busy_id))
    busy = await client.delete(exports_url(busy_in, busy_id))
    assert (busy.status_code, busy.json()) == (409, {"detail": "正在交给渲染服务，稍后再取消"})

    finished_in, finished_id = await handed_over_export(client, generations, render, owner)
    render.advance(finished_id, status="done", progress=1.0)
    await queue.run_poll(finished_id)
    assert (await client.delete(exports_url(finished_in, finished_id))).status_code == 204
    assert (await record(generations, finished_id)).status == STATUS_COMPLETED


async def test_the_render_lane_waits_six_hours_while_other_lanes_keep_the_default(
    client: httpx.AsyncClient,
    pg_url: str,
    engine: AsyncEngine,
    generations: SqlGenerationRepository,
    render: StubRender,
    queue: GenerationQueue,
) -> None:
    owner = uuid.UUID(await login_as_editor(client, pg_url))
    _, export_id = await handed_over_export(client, generations, render, owner)
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
    mine, export_id = await queued_export(client, generations, owner)
    another = await new_conversation(client)

    async with make_client(export_app) as stranger, make_client(export_app) as governor:
        await login_as_editor(stranger, pg_url, username="mallory")
        await register_and_login(governor, username="gov", email="gov@example.com")
        await set_roles_in_db(pg_url, "gov@example.com", ["root"])
        for http, status in ((stranger, 404), (governor, 403)):
            assert (await http.post(exports_url(mine))).status_code == status
            assert (await http.get(exports_url(mine, "latest"))).status_code == status
            assert (await http.delete(exports_url(mine, export_id))).status_code == status

    elsewhere = await client.delete(exports_url(another, export_id))
    assert elsewhere.status_code == 404
    assert (await client.delete(exports_url(mine, str(uuid.uuid4())))).status_code == 404
    assert (await record(generations, export_id)).error_code is None


@pytest.fixture
async def unrendered_app(
    base_env: None, engine: AsyncEngine, monkeypatch: pytest.MonkeyPatch, render: StubRender
) -> FastAPI:
    return await build_whole_film_app(monkeypatch, engine, render, render_url=None)


async def test_without_a_render_service_starting_is_paused_and_the_rest_is_unavailable(
    unrendered_app: FastAPI, pg_url: str
) -> None:
    async with make_client(unrendered_app) as http:
        await login_as_editor(http, pg_url)
        mine = await new_conversation(http)
        started = await http.post(exports_url(mine))
        read = await http.get(exports_url(mine, "latest"))
        cancelled = await http.delete(exports_url(mine, str(uuid.uuid4())))

    assert (started.status_code, started.json()) == (422, PAUSED)
    assert (read.status_code, read.json()) == (422, {"detail": "成片导出没有开通"})
    assert cancelled.status_code == 422
