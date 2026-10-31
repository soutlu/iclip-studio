"""对话的视频进度：还有视频记录没跑完的对话各到哪一步，范围按记录的属主。

记录经生成仓储直接落库，不起队列；开着媒体生成装应用，没开时接口只会答空。"""

from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator

import httpx
import pytest
from fastapi import FastAPI
from procrastinate.testing import InMemoryConnector
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.domains.generation.infra_sql import SqlGenerationRepository
from iclip.domains.generation.models import GenerationOutput
from iclip.platform.media.codec import SOFTWARE
from tests.helpers.app import make_client
from tests.helpers.auth import login_as_editor, register_and_login, set_roles_in_db
from tests.helpers.generation import (
    MEDIA_ENVS,
    config_with_media,
    image_request,
    make_job,
    video_request,
)
from tests.helpers.model_providers import GOOD_KEY, KeyCheckingProbe
from tests.helpers.runtime_backed import build_backed_app

URL = "/conversations/video-progress"


@pytest.fixture
async def media_app(
    base_env: None, engine: AsyncEngine, monkeypatch: pytest.MonkeyPatch
) -> FastAPI:
    for name, value in MEDIA_ENVS.items():
        monkeypatch.setenv(name, value)
    monkeypatch.delenv("WHOLE_FILM_RENDER_URL", raising=False)
    return build_backed_app(
        config_with_media(),
        engine=engine,
        queue_connector=InMemoryConnector(),
        media_codec=SOFTWARE,
        credential_probe=KeyCheckingProbe({GOOD_KEY}),
    )


@pytest.fixture
async def client(media_app: FastAPI) -> AsyncGenerator[httpx.AsyncClient]:
    async with make_client(media_app) as http:
        yield http


async def _pending(
    repo: SqlGenerationRepository, owner: uuid.UUID, conversation: uuid.UUID | None
) -> uuid.UUID:
    job = await repo.create(
        make_job(video_request(), owner_user_id=owner, conversation_id=conversation)
    )
    return job.id


async def _seed_own(repo: SqlGenerationRepository, owner: uuid.UUID) -> dict[str, str]:
    """一个人名下各种状态的记录；交回应当列出的那几段对话与它们的阶段。"""

    queued, submitting, submitted = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    await _pending(repo, owner, queued)
    await _pending(repo, owner, queued)

    await _pending(repo, owner, submitting)
    await repo.mark_submitting(await _pending(repo, owner, submitting))

    await _pending(repo, owner, submitted)
    handed_over = await _pending(repo, owner, submitted)
    await repo.mark_submitting(handed_over)
    await repo.mark_submitted(handed_over, provider_task_id="up-1", provider_status="running")

    completed = await _pending(repo, owner, uuid.uuid4())
    await repo.mark_completed(
        completed,
        output=GenerationOutput(url="https://cdn.example.test/done.mp4"),
        provider_status="succeeded",
    )
    failed = await _pending(repo, owner, uuid.uuid4())
    await repo.mark_failed(failed, error_code="UPSTREAM", error_message="上游拒绝")
    await repo.create(make_job(image_request(), owner_user_id=owner, conversation_id=uuid.uuid4()))
    await _pending(repo, owner, None)

    return {str(queued): "queued", str(submitting): "running", str(submitted): "running"}


async def _progress(http: httpx.AsyncClient) -> dict[str, str]:
    response = await http.get(URL)
    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == {"conversations"}
    conversations: dict[str, str] = body["conversations"]
    return conversations


async def test_video_progress_lists_unfinished_videos_by_conversation_within_what_one_may_see(
    client: httpx.AsyncClient, media_app: FastAPI, engine: AsyncEngine, pg_url: str
) -> None:
    """全在排队是 queued，有一条提交中或已交给上游就是 running；跑完、失败、图片与没挂对话的
    记录都不列。普通用户只看自己的，治理者与替人办事的钥匙看全平台。"""

    repo = SqlGenerationRepository(engine)
    logan = uuid.UUID(await login_as_editor(client, pg_url))
    own = await _seed_own(repo, logan)

    async with make_client(media_app) as mallory_http:
        mallory = uuid.UUID(await login_as_editor(mallory_http, pg_url, username="mallory"))
        theirs = uuid.uuid4()
        await _pending(repo, mallory, theirs)
        everyone = {**own, str(theirs): "queued"}

        assert await _progress(client) == own
        assert await _progress(mallory_http) == {str(theirs): "queued"}

    async with make_client(media_app) as governor:
        await register_and_login(governor, username="gov", email="gov@example.com")
        await set_roles_in_db(pg_url, "gov@example.com", ["root"])
        assert await _progress(governor) == everyone

        issued = await governor.post(
            "/api-keys",
            json={"name": "partner-app", "permissions": ["agent:read", "users:act_as"]},
        )
        assert issued.status_code == 201, issued.text
        token = issued.json()["apiKey"]["token"]

    async with make_client(media_app) as gateway:
        gateway.headers["Authorization"] = f"Bearer {token}"
        assert await _progress(gateway) == everyone


async def test_video_progress_is_empty_when_nothing_is_running(
    client: httpx.AsyncClient, pg_url: str
) -> None:
    await login_as_editor(client, pg_url)

    assert await _progress(client) == {}
