"""已有整片在生成记录里的位置：旧请求照常读回，整片不能当基底，完成后照常排字幕记录。

用内存仓储与真实队列协程，provider 全是替身，不碰 ffmpeg。"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

import httpx
from fastapi import FastAPI
from procrastinate.testing import InMemoryConnector

from iclip.domains.generation.api import create_generations_router
from iclip.domains.generation.film_schemas import WholeFilmRender, WholeFilmRequest
from iclip.domains.generation.models import STATUS_COMPLETED, GenerationJob
from iclip.domains.generation.nano_banana import NANO_BANANA_PRO
from iclip.domains.generation.provider import ProviderSubmission
from iclip.domains.generation.queue import GenerationQueue, ProviderLane
from iclip.domains.generation.service import GenerationService, ProviderTarget
from iclip.domains.identity.acting import ActAs
from iclip.domains.identity.models import Principal
from tests.helpers.app import app_with_principal
from tests.helpers.generation import (
    FAKE_IMAGE_PROVIDER,
    FAKE_SUBTITLE_PROVIDER,
    FAKE_VIDEO_PROVIDER,
    QUEUE_SETTINGS,
    FakeMediaProbe,
    FixedLineage,
    InMemoryGenerationRepository,
    ScriptedProvider,
    make_job,
    make_whole_film,
    video_request,
)
from tests.helpers.identity import InMemoryUserRepository

TAKE_URL = "https://cdn.test/take.mp4"
FILM_URL = "https://cdn.test/iclip/agent/video-masters/film.mp4"
MUSIC_URL = "https://cdn.test/iclip/agent/generated-music/m.m4a"


async def _keep_completion(_conversation_id: uuid.UUID, _owner: uuid.UUID) -> None:
    return None


def build_world(
    jobs: list[GenerationJob], *, compose_submission: ProviderSubmission | None = None
) -> tuple[InMemoryGenerationRepository, GenerationQueue, GenerationService]:
    """真队列与真服务：字幕识别开着，完成回调接到服务上，与装配一致。"""

    store = InMemoryGenerationRepository(jobs)
    lanes = tuple(
        ProviderLane(provider, 1)
        for provider in (
            ScriptedProvider(name=FAKE_VIDEO_PROVIDER),
            ScriptedProvider(name="ffmpeg", submission=compose_submission),
            ScriptedProvider(name=FAKE_IMAGE_PROVIDER),
            ScriptedProvider(name=FAKE_SUBTITLE_PROVIDER),
        )
    )
    holder: dict[str, GenerationService] = {}

    async def on_completed(job: GenerationJob) -> None:
        await holder["service"].transcribe_completed(job)

    queue = GenerationQueue(
        store,
        lanes=lanes,
        connector=InMemoryConnector(),
        settings=QUEUE_SETTINGS,
        on_completed=on_completed,
    )
    service = GenerationService(
        store,
        queue,
        video_provider_name=FAKE_VIDEO_PROVIDER,
        compose_provider_name="ffmpeg",
        video_default_model="vendor-a-seedance-2-5",
        video_allowed_models=("vendor-a-seedance-2-5",),
        image_models={"nano_banana_pro": NANO_BANANA_PRO.spec},
        image_default_model="nano_banana_pro",
        clear_completion=_keep_completion,
        lineage=FixedLineage(),
        media_probe=FakeMediaProbe(),
        subtitles=ProviderTarget(provider=FAKE_SUBTITLE_PROVIDER, model="qwen-audio-3.1-asr-flash"),
    )
    holder["service"] = service
    return store, queue, service


def completed_take(**fields: Any) -> GenerationJob:
    fields.setdefault("output_url", TAKE_URL)
    fields.setdefault("watermark_output_url", "https://cdn.test/take-wm.mp4")
    fields.setdefault("finished_at", datetime.now(UTC))
    return make_job(video_request(), status=STATUS_COMPLETED, **fields)


def test_existing_film_requests_keep_the_automatic_volume_baseline() -> None:
    request = WholeFilmRequest.model_validate(
        {
            "segments": [
                {"sourceJobId": str(uuid.uuid4()), "url": TAKE_URL, "startMs": 0, "endMs": 1000}
            ],
            "music": {
                "audioJobId": str(uuid.uuid4()),
                "url": MUSIC_URL,
                "offsetMs": 0,
                "gain": [{"atMs": 0, "gain": 0.3}],
            },
            "subtitles": [],
            "render": WholeFilmRender().model_dump(by_alias=True),
            "font": None,
            "intro": None,
            "outro": None,
        }
    )
    assert request.segments[0].volume == 1
    assert request.music is not None and request.music.volume == 1


async def test_a_whole_film_cannot_be_the_base_of_an_edit_or_a_composite() -> None:
    me, conversation = uuid.uuid4(), uuid.uuid4()
    take = completed_take(owner_user_id=me, conversation_id=conversation)
    film = make_whole_film(
        take, status=STATUS_COMPLETED, output_url=FILM_URL, finished_at=datetime.now(UTC)
    )
    repo, _, service = build_world([take, film])
    app: FastAPI = app_with_principal(
        Principal(
            kind="user",
            user_id=me,
            permissions=frozenset({"generation:submit"}),
            audit_label="tester",
            username="tester",
        )
    )
    app.include_router(create_generations_router(service, act_as=ActAs(InMemoryUserRepository())))
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as http:
        edit = await http.post(
            "/generations/video-edits",
            json={
                "source_job_id": str(film.id),
                "range_start_ms": 0,
                "range_end_ms": 1000,
                "reference_video_urls": ["https://cdn.test/iclip/agent/uploads/clip.mp4"],
                "model": "vendor-a-seedance-2-5",
                "seconds": -1,
                "prompt": "换个颜色",
                "conversation_id": str(conversation),
            },
        )
        composite = await http.post(
            "/generations/video-composites",
            json={
                "baseJobId": str(film.id),
                "segments": [{"sourceJobId": str(film.id), "start": 0}],
                "conversationId": str(conversation),
            },
        )

    for response in (edit, composite):
        assert response.status_code == 422, response.text
        assert "整片不能当基底" in response.json()["detail"]
    assert len(repo.jobs) == 2, "都不建记录"


async def test_a_finished_whole_film_is_transcribed_like_any_master() -> None:
    take = completed_take(conversation_id=uuid.uuid4(), task_id=uuid.uuid4())
    film = make_whole_film(take, task_id=take.task_id)
    repo, queue, _ = build_world(
        [take, film],
        compose_submission=ProviderSubmission(
            provider_task_id=str(film.id),
            provider_status="completed",
            output_url=FILM_URL,
            duration_ms=1000,
        ),
    )

    await queue.run_submit(str(film.id))

    stored = repo.jobs[film.id]
    assert (stored.status, stored.output_url, stored.duration_ms) == (
        STATUS_COMPLETED,
        FILM_URL,
        1000,
    )
    (subtitle,) = [job for job in repo.jobs.values() if job.kind == "subtitle"]
    assert (subtitle.source_job_id, subtitle.conversation_id, subtitle.task_id) == (
        film.id,
        film.conversation_id,
        film.task_id,
    )
