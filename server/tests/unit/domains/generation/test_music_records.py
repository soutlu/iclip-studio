"""音频记录里生成的背景音乐：端点受理（提示词原样、对话必填、读不到对话 404、没开通 422、代办）、
结果落库与读出、失败不重投，以及它不触发字幕识别、不动收尾标记。

用内存仓储与真实队列协程，provider 全是替身，不碰音乐模型。"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from procrastinate.testing import InMemoryConnector

from iclip.domains.generation.api import create_generations_router
from iclip.domains.generation.models import (
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_PENDING,
    GenerationJob,
)
from iclip.domains.generation.nano_banana import NANO_BANANA_PRO
from iclip.domains.generation.provider import ProviderError, ProviderSubmission
from iclip.domains.generation.queue import GenerationQueue, ProviderLane, submit_queue
from iclip.domains.generation.schemas import MAX_MUSIC_PROMPT_CHARS, MusicRequest
from iclip.domains.generation.service import GenerationService, ProviderTarget
from iclip.domains.identity.acting import ActAs, placeholder_email
from iclip.domains.identity.models import Principal
from iclip.domains.identity.rbac import ACT_AS_PERMISSION
from tests.helpers.app import app_with_principal
from tests.helpers.generation import (
    FAKE_IMAGE_PROVIDER,
    FAKE_MUSIC_PROVIDER,
    FAKE_SUBTITLE_PROVIDER,
    FAKE_VIDEO_PROVIDER,
    MUSIC_PROMPT,
    QUEUE_SETTINGS,
    FakeMediaProbe,
    FixedBrandTemplates,
    FixedLineage,
    InMemoryGenerationRepository,
    ScriptedProvider,
    make_music,
)
from tests.helpers.identity import InMemoryUserRepository

MODEL = "qwen-audio-3.1-tts-next"
MUSIC = ProviderTarget(provider=FAKE_MUSIC_PROVIDER, model=MODEL)
MUSIC_URL = "https://cdn.test/iclip/agent/generated-music/m.m4a"


class _ClearedCompletions:
    def __init__(self) -> None:
        self.calls: list[tuple[uuid.UUID, uuid.UUID]] = []

    async def record(self, conversation_id: uuid.UUID, owner: uuid.UUID) -> None:
        self.calls.append((conversation_id, owner))


@dataclass
class World:
    repo: InMemoryGenerationRepository
    queue: GenerationQueue
    connector: InMemoryConnector
    service: GenerationService
    music: ScriptedProvider
    cleared: _ClearedCompletions

    def kind(self, kind: str) -> list[GenerationJob]:
        return [job for job in self.repo.jobs.values() if job.kind == kind]

    def tasks(self, name: str, provider: str | None = None) -> list[dict[str, Any]]:
        return [
            dict(row)
            for row in self.connector.jobs.values()
            if row["task_name"] == name
            and (provider is None or row["queue_name"] == submit_queue(provider))
        ]


def build_world(
    jobs: list[GenerationJob],
    *,
    music: ProviderTarget | None = MUSIC,
    music_submission: ProviderSubmission | Exception | None = None,
    lineage: FixedLineage | None = None,
) -> World:
    """装一个真队列与真服务：字幕识别也开着，完成回调接到服务上，与装配一致。"""

    store = InMemoryGenerationRepository()
    for job in jobs:
        store.jobs[job.id] = job
    doubles = (
        ScriptedProvider(name=FAKE_VIDEO_PROVIDER),
        ScriptedProvider(name="ffmpeg"),
        ScriptedProvider(name=FAKE_IMAGE_PROVIDER),
        ScriptedProvider(name=FAKE_SUBTITLE_PROVIDER),
    )
    composer = ScriptedProvider(name=FAKE_MUSIC_PROVIDER, submission=music_submission)
    connector = InMemoryConnector()
    cleared = _ClearedCompletions()
    holder: dict[str, GenerationService] = {}

    async def on_completed(job: GenerationJob) -> None:
        await holder["service"].transcribe_completed(job)

    queue = GenerationQueue(
        store,
        lanes=tuple(ProviderLane(provider, 1) for provider in (*doubles, composer)),
        connector=connector,
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
        clear_completion=cleared.record,
        lineage=lineage or FixedLineage(),
        media_probe=FakeMediaProbe(),
        brand_templates=FixedBrandTemplates(),
        subtitles=ProviderTarget(provider=FAKE_SUBTITLE_PROVIDER, model="qwen-audio-3.1-asr-flash"),
        music=music,
    )
    holder["service"] = service
    return World(store, queue, connector, service, composer, cleared)


def principal(*permissions: str, user_id: uuid.UUID | None = None) -> Principal:
    return Principal(
        kind="user",
        user_id=user_id or uuid.uuid4(),
        permissions=frozenset(permissions),
        audit_label="tester",
        username="tester",
    )


def api_key(*permissions: str) -> Principal:
    return Principal(
        kind="api_key",
        user_id=uuid.uuid4(),
        permissions=frozenset(permissions),
        audit_label="logan#ci",
        api_key_id=uuid.uuid4(),
        username="logan",
        key_name="ci",
    )


def client(
    world: World, granted: Principal, users: InMemoryUserRepository | None = None
) -> httpx.AsyncClient:
    app: FastAPI = app_with_principal(granted)
    app.include_router(
        create_generations_router(world.service, act_as=ActAs(users or InMemoryUserRepository()))
    )
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver")


# --- 受理 -----------------------------------------------------------------------


async def test_the_prompt_is_recorded_and_queued_exactly_as_sent() -> None:
    me, conversation, task = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    prompt = "  轻快的城市流行节拍，\n适合鞋款种草短视频  "
    world = build_world([])
    async with client(world, principal("generation:submit", user_id=me)) as http:
        response = await http.post(
            "/generations/music",
            json={
                "prompt": prompt,
                "conversationId": str(conversation),
                "taskId": str(task),
                "metadata": {"film": "整片"},
            },
        )

    assert response.status_code == 202, response.text
    (music,) = world.kind("audio")
    generation = response.json()["generation"]
    assert (generation["id"], generation["kind"], generation["operation"]) == (
        str(music.id),
        "audio",
        "generate",
    )
    assert (generation["status"], generation["outputUrl"], generation["durationMs"]) == (
        STATUS_PENDING,
        None,
        None,
    )
    assert generation["request"] == {
        "model": MODEL,
        "prompt": prompt,
        "format": "wav",
        "sampleRate": 48000,
        "channels": 2,
    }, "提示词一字不改，不补要求、不收时长"
    assert music.request == MusicRequest(model=MODEL, prompt=prompt)
    assert (music.owner_user_id, music.conversation_id, music.task_id, music.metadata) == (
        me,
        conversation,
        task,
        {"film": "整片"},
    )
    assert (music.source_job_id, music.root_job_id, music.shot_index) == (None, None, None)
    assert len(world.tasks("generation.submit", FAKE_MUSIC_PROVIDER)) == 1
    assert world.cleared.calls == [], "音频记录不是出片，不动收尾标记"


@pytest.mark.parametrize(
    ("body", "accepted"),
    [
        ({"prompt": "乐" * MAX_MUSIC_PROMPT_CHARS}, True),
        ({"prompt": "乐" * (MAX_MUSIC_PROMPT_CHARS + 1)}, False),
        ({"prompt": ""}, False),
        ({"prompt": "   \n"}, False),
        ({}, False),
    ],
    ids=["正好 3000 字", "超过 3000 字", "空", "全是空白", "没给"],
)
async def test_the_prompt_is_checked_against_the_model_limit_on_input(
    body: dict[str, Any], accepted: bool
) -> None:
    world = build_world([])
    async with client(world, principal("generation:submit")) as http:
        response = await http.post(
            "/generations/music", json={**body, "conversationId": str(uuid.uuid4())}
        )

    assert response.status_code == (202 if accepted else 422), response.text
    assert len(world.kind("audio")) == (1 if accepted else 0)


async def test_the_conversation_is_required() -> None:
    world = build_world([])
    async with client(world, principal("generation:submit")) as http:
        response = await http.post("/generations/music", json={"prompt": MUSIC_PROMPT})

    assert response.status_code == 422
    assert world.kind("audio") == []


async def test_a_conversation_the_caller_cannot_read_is_404() -> None:
    world = build_world([], lineage=FixedLineage(readable=False))
    async with client(world, principal("generation:submit")) as http:
        response = await http.post(
            "/generations/music",
            json={"prompt": MUSIC_PROMPT, "conversationId": str(uuid.uuid4())},
        )

    assert response.status_code == 404, response.text
    assert world.kind("audio") == []


async def test_generating_music_is_refused_when_it_is_not_configured() -> None:
    world = build_world([], music=None)
    async with client(world, principal("generation:submit")) as http:
        response = await http.post(
            "/generations/music",
            json={"prompt": MUSIC_PROMPT, "conversationId": str(uuid.uuid4())},
        )

    assert response.status_code == 422, response.text
    assert "没有开通" in response.json()["detail"]
    assert world.kind("audio") == []


async def test_generating_music_settles_the_author_like_other_submits() -> None:
    """钥匙不报名字就拒；持 users:act_as 的钥匙报了名字，属主换成那个人；浏览器只能报自己。
    名字只用来换属主，不进请求。"""

    users = InMemoryUserRepository()
    sara = await users.ensure_by_name("Sara.Hong", email=placeholder_email("Sara.Hong"))
    world = build_world([])
    key = api_key("generation:submit", ACT_AS_PERMISSION)
    body = {"prompt": MUSIC_PROMPT, "conversationId": str(uuid.uuid4())}
    async with client(world, key, users) as http:
        nameless = await http.post("/generations/music", json=body)
        acting = await http.post("/generations/music", json={**body, "userName": "Sara.Hong"})
    async with client(world, principal("generation:submit", user_id=sara)) as http:
        someone_else = await http.post("/generations/music", json={**body, "userName": "bob"})

    assert nameless.status_code == 422
    assert acting.status_code == 202, acting.text
    (music,) = world.kind("audio")
    assert (music.owner_user_id, music.api_key_id) == (sara, key.api_key_id)
    assert "userName" not in acting.json()["generation"]["request"]
    assert someone_else.status_code == 422


async def test_generating_music_needs_the_submit_permission() -> None:
    world = build_world([])
    async with client(world, principal("generation:read")) as http:
        response = await http.post(
            "/generations/music",
            json={"prompt": MUSIC_PROMPT, "conversationId": str(uuid.uuid4())},
        )

    assert response.status_code == 403


# --- 执行结果 -------------------------------------------------------------------


async def test_generated_music_completes_with_its_address_and_duration_and_nothing_else() -> None:
    music = make_music()
    world = build_world(
        [music],
        music_submission=ProviderSubmission(
            provider_task_id="req-7",
            provider_status="succeeded",
            output_url=MUSIC_URL,
            duration_ms=31_500,
        ),
    )

    await world.queue.run_submit(str(music.id))

    stored = world.repo.jobs[music.id]
    assert (stored.status, stored.output_url, stored.duration_ms) == (
        STATUS_COMPLETED,
        MUSIC_URL,
        31_500,
    )
    assert stored.provider_task_id == "req-7"
    assert world.tasks("generation.poll") == [], "同步出结果，没有轮询"
    assert world.kind("subtitle") == [], "音频记录完成不识别字幕"
    assert world.cleared.calls == []


async def test_a_failed_generation_is_recorded_and_never_resubmitted() -> None:
    music = make_music()
    world = build_world(
        [music],
        music_submission=ProviderError(
            "音乐已生成但存不进桶", code="OUTPUT_STORE_FAILED", retryable=True
        ),
    )

    await world.queue.run_submit(str(music.id))
    await world.queue.run_submit(str(music.id))

    stored = world.repo.jobs[music.id]
    assert (stored.status, stored.error_code, stored.output_url) == (
        STATUS_FAILED,
        "OUTPUT_STORE_FAILED",
        None,
    )
    assert world.music.submit_calls == [music.id], "失败就停，重来只能另起一条"
    assert world.tasks("generation.submit", FAKE_MUSIC_PROVIDER) == []


# --- 读取 -----------------------------------------------------------------------


async def test_generated_music_reads_back_by_id_and_by_kind_and_conversation() -> None:
    me, conversation = uuid.uuid4(), uuid.uuid4()
    music = make_music(
        owner_user_id=me,
        conversation_id=conversation,
        status=STATUS_COMPLETED,
        output_url=MUSIC_URL,
        duration_ms=31_500,
        finished_at=datetime.now(UTC),
    )
    other = make_music(owner_user_id=me)
    world = build_world([music, other])
    async with client(world, principal("generation:read", user_id=me)) as http:
        single = await http.get(f"/generations/{music.id}")
        listed = await http.get(f"/generations?kind=audio&conversationId={conversation}")
        as_video_task = await http.get(f"/generations/video/{music.id}")

    assert single.status_code == 200, single.text
    generation = single.json()["generation"]
    assert (generation["kind"], generation["outputUrl"], generation["durationMs"]) == (
        "audio",
        MUSIC_URL,
        31_500,
    )
    assert (generation["sourceJobId"], generation["sourceUrl"], generation["sentences"]) == (
        None,
        None,
        None,
    )
    assert [item["id"] for item in listed.json()["items"]] == [str(music.id)]
    assert as_video_task.status_code == 404, "音频记录不是视频任务"
