"""字幕记录：成片完成后自动排一条、手动端点另起一条、识别结果落库与读出、失败不重投。

用内存仓储与真实队列协程，provider 全是替身，不碰识别服务。"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from procrastinate.testing import InMemoryConnector
from structlog.testing import capture_logs

from iclip.domains.generation.api import create_generations_router
from iclip.domains.generation.models import (
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_PENDING,
    STATUS_SUBMITTED,
    GenerationJob,
)
from iclip.domains.generation.nano_banana import NANO_BANANA_PRO
from iclip.domains.generation.provider import (
    ProviderError,
    ProviderProgress,
    ProviderSubmission,
)
from iclip.domains.generation.queue import GenerationQueue, ProviderLane, submit_queue
from iclip.domains.generation.schemas import SubtitleRequest, SubtitleSentence
from iclip.domains.generation.service import GenerationService, ProviderTarget
from iclip.domains.identity.acting import ActAs, placeholder_email
from iclip.domains.identity.models import Principal
from iclip.domains.identity.rbac import ACT_AS_PERMISSION
from tests.helpers.app import app_with_principal
from tests.helpers.generation import (
    FAKE_IMAGE_PROVIDER,
    FAKE_SUBTITLE_PROVIDER,
    FAKE_VIDEO_PROVIDER,
    QUEUE_SETTINGS,
    FakeMediaProbe,
    FixedBrandTemplates,
    FixedLineage,
    InMemoryGenerationRepository,
    ScriptedProvider,
    image_request,
    make_composite,
    make_edit,
    make_job,
    make_subtitle,
    video_request,
)
from tests.helpers.identity import InMemoryUserRepository

TAKE_URL = "https://cdn.test/video/take.mp4"
TAKE_WATERMARK_URL = "https://cdn.test/video/take-wm.mp4"
COMPOSITE_URL = "https://cdn.test/video/composite.mp4"
MODEL = "qwen-audio-3.1-asr-flash"
SUBTITLES = ProviderTarget(provider=FAKE_SUBTITLE_PROVIDER, model=MODEL)

SENTENCES = (
    SubtitleSentence(start_ms=100, end_ms=1800, text="第一句。", speaker=0),
    SubtitleSentence(start_ms=2000, end_ms=3000, text="第二句。", speaker=None),
)


class _CreateFailsForSubtitles(InMemoryGenerationRepository):
    """建字幕记录时数据库出错，其余照常。"""

    async def create(self, job: GenerationJob) -> GenerationJob:
        if job.kind == "subtitle":
            raise RuntimeError("数据库连接断了")
        return await super().create(job)


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
    asr: ScriptedProvider
    cleared: _ClearedCompletions

    def subtitles(self) -> list[GenerationJob]:
        return [job for job in self.repo.jobs.values() if job.kind == "subtitle"]

    def submits_to(self, provider: str) -> list[dict[str, Any]]:
        return [
            dict(row)
            for row in self.connector.jobs.values()
            if row["task_name"] == "generation.submit"
            and row["queue_name"] == submit_queue(provider)
        ]


def build_world(
    jobs: list[GenerationJob],
    *,
    subtitles: ProviderTarget | None = SUBTITLES,
    repo: InMemoryGenerationRepository | None = None,
    video_progress: ProviderProgress | None = None,
    compose_submission: ProviderSubmission | None = None,
    image_submission: ProviderSubmission | None = None,
    asr_submission: ProviderSubmission | Exception | None = None,
    lineage: FixedLineage | None = None,
) -> World:
    """装一个真队列与真服务：成片完成的回调接到服务上，与装配一致。"""

    store = repo if repo is not None else InMemoryGenerationRepository()
    for job in jobs:
        store.jobs[job.id] = job
    video = ScriptedProvider(name=FAKE_VIDEO_PROVIDER, progress=video_progress)
    compose = ScriptedProvider(name="ffmpeg", submission=compose_submission)
    image = ScriptedProvider(name=FAKE_IMAGE_PROVIDER, submission=image_submission)
    asr = ScriptedProvider(name=FAKE_SUBTITLE_PROVIDER, submission=asr_submission)
    connector = InMemoryConnector()
    cleared = _ClearedCompletions()
    holder: dict[str, GenerationService] = {}

    async def on_completed(job: GenerationJob) -> None:
        await holder["service"].transcribe_completed(job)

    queue = GenerationQueue(
        store,
        lanes=tuple(ProviderLane(provider, 1) for provider in (video, compose, image, asr)),
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
        subtitles=subtitles,
    )
    holder["service"] = service
    return World(store, queue, connector, service, asr, cleared)


def submitted_take(**fields: Any) -> GenerationJob:
    """一条交给上游、等结果的出片。"""

    return make_job(
        video_request(),
        status=STATUS_SUBMITTED,
        provider_task_id="up-1",
        submitted_at=datetime.now(UTC),
        **fields,
    )


def completed_take(**fields: Any) -> GenerationJob:
    fields.setdefault("output_url", TAKE_URL)
    fields.setdefault("watermark_output_url", TAKE_WATERMARK_URL)
    fields.setdefault("finished_at", datetime.now(UTC))
    return make_job(video_request(), status=STATUS_COMPLETED, **fields)


TAKE_SUCCEEDED = ProviderProgress(
    outcome="succeeded",
    provider_status="succeeded",
    output_url=TAKE_URL,
    watermark_output_url=TAKE_WATERMARK_URL,
)


# --- 自动触发 -------------------------------------------------------------------


async def test_a_completed_take_queues_one_subtitle_record_that_keeps_its_attribution() -> None:
    take = replace(
        submitted_take(conversation_id=uuid.uuid4(), task_id=uuid.uuid4(), shot_index=2),
        api_key_id=uuid.uuid4(),
    )
    world = build_world([take], video_progress=TAKE_SUCCEEDED)

    await world.queue.run_poll(str(take.id))

    assert world.repo.jobs[take.id].status == STATUS_COMPLETED
    (subtitle,) = world.subtitles()
    assert (subtitle.status, subtitle.operation, subtitle.provider) == (
        STATUS_PENDING,
        "generate",
        FAKE_SUBTITLE_PROVIDER,
    )
    assert subtitle.source_job_id == take.id
    assert (
        subtitle.owner_user_id,
        subtitle.api_key_id,
        subtitle.conversation_id,
        subtitle.task_id,
    ) == (take.owner_user_id, take.api_key_id, take.conversation_id, take.task_id)
    assert (subtitle.shot_index, subtitle.root_job_id, subtitle.output_url) == (None, None, None)
    assert subtitle.request == SubtitleRequest(model=MODEL, video_url=TAKE_URL), "原片，不是水印版"
    assert [row["args"]["job_id"] for row in world.submits_to(FAKE_SUBTITLE_PROVIDER)] == [
        str(subtitle.id)
    ]
    assert world.cleared.calls == [], "后台识别不是人在对话里动手，不动收尾标记"


async def test_a_completed_composite_queues_a_subtitle_record_too() -> None:
    take = completed_take()
    composite = make_composite(make_edit(take), conversation_id=uuid.uuid4())
    world = build_world(
        [take, composite],
        compose_submission=ProviderSubmission(
            provider_task_id=str(composite.id),
            provider_status="completed",
            output_url=COMPOSITE_URL,
        ),
    )

    await world.queue.run_submit(str(composite.id))

    assert world.repo.jobs[composite.id].status == STATUS_COMPLETED
    (subtitle,) = world.subtitles()
    assert subtitle.source_job_id == composite.id
    assert subtitle.request == SubtitleRequest(model=MODEL, video_url=COMPOSITE_URL)
    assert subtitle.conversation_id == composite.conversation_id


async def test_a_completed_edit_segment_is_not_transcribed() -> None:
    edit = replace(
        make_edit(completed_take()),
        status=STATUS_SUBMITTED,
        provider_task_id="up-2",
        submitted_at=datetime.now(UTC),
    )
    world = build_world([edit], video_progress=TAKE_SUCCEEDED)

    await world.queue.run_poll(str(edit.id))

    assert world.repo.jobs[edit.id].status == STATUS_COMPLETED
    assert world.subtitles() == []


async def test_a_completed_image_is_not_transcribed() -> None:
    image = make_job(image_request())
    world = build_world(
        [image],
        image_submission=ProviderSubmission(
            provider_task_id="img-1",
            provider_status="succeeded",
            output_url="https://cdn.test/a.png",
        ),
    )

    await world.queue.run_submit(str(image.id))

    assert world.repo.jobs[image.id].status == STATUS_COMPLETED
    assert world.subtitles() == []


async def test_a_failed_take_is_not_transcribed() -> None:
    take = submitted_take()
    world = build_world(
        [take],
        video_progress=ProviderProgress(
            outcome="failed", provider_status="failed", error_code="BOOM", error_message="坏了"
        ),
    )

    await world.queue.run_poll(str(take.id))

    assert world.repo.jobs[take.id].status == STATUS_FAILED
    assert world.subtitles() == []


async def test_nothing_is_transcribed_when_subtitles_are_not_configured() -> None:
    take = submitted_take()
    world = build_world([take], subtitles=None, video_progress=TAKE_SUCCEEDED)

    await world.queue.run_poll(str(take.id))

    assert world.repo.jobs[take.id].status == STATUS_COMPLETED
    assert world.subtitles() == []


async def test_failing_to_create_the_subtitle_record_leaves_the_take_completed() -> None:
    take = submitted_take()
    world = build_world([take], repo=_CreateFailsForSubtitles(), video_progress=TAKE_SUCCEEDED)

    with capture_logs() as logs:
        await world.queue.run_poll(str(take.id))

    assert world.repo.jobs[take.id].status == STATUS_COMPLETED
    assert world.subtitles() == []
    errors = [entry for entry in logs if entry["log_level"] == "error"]
    assert [(entry["event"], entry["job_id"]) for entry in errors] == [
        ("生成任务完成后的后续动作失败", take.id)
    ], "只由队列记一条，不重复记"


# --- 识别结果与失败 ---------------------------------------------------------------


async def test_a_recognized_subtitle_record_completes_with_its_sentences_and_no_address() -> None:
    subtitle = make_subtitle(completed_take())
    world = build_world(
        [subtitle],
        asr_submission=ProviderSubmission(
            provider_task_id="req-1", provider_status="succeeded", sentences=SENTENCES
        ),
    )

    await world.queue.run_submit(str(subtitle.id))

    stored = world.repo.jobs[subtitle.id]
    assert (stored.status, stored.sentences, stored.output_url) == (
        STATUS_COMPLETED,
        SENTENCES,
        None,
    )
    assert stored.provider_task_id == "req-1"
    polls = [row for row in world.connector.jobs.values() if row["task_name"] == "generation.poll"]
    assert polls == [], "同步出结果，没有轮询"
    assert world.subtitles() == [stored], "字幕记录完成不会再排字幕"


async def test_no_voice_over_completes_with_an_empty_sentence_list() -> None:
    subtitle = make_subtitle(completed_take())
    world = build_world(
        [subtitle],
        asr_submission=ProviderSubmission(
            provider_task_id=str(subtitle.id), provider_status="no_audio", sentences=()
        ),
    )

    await world.queue.run_submit(str(subtitle.id))

    assert (world.repo.jobs[subtitle.id].status, world.repo.jobs[subtitle.id].sentences) == (
        STATUS_COMPLETED,
        (),
    )


async def test_a_failed_recognition_is_recorded_and_never_resubmitted() -> None:
    subtitle = make_subtitle(completed_take())
    world = build_world(
        [subtitle],
        asr_submission=ProviderError("等不到结果", code="PROVIDER_RESULT_UNKNOWN", retryable=True),
    )

    await world.queue.run_submit(str(subtitle.id))
    await world.queue.run_submit(str(subtitle.id))

    stored = world.repo.jobs[subtitle.id]
    assert (stored.status, stored.error_code, stored.error_message) == (
        STATUS_FAILED,
        "PROVIDER_RESULT_UNKNOWN",
        "等不到结果",
    )
    assert world.asr.submit_calls == [subtitle.id], "失败就停，重来只能手动另起一条"
    assert world.submits_to(FAKE_SUBTITLE_PROVIDER) == []


# --- 手动识别端点 -----------------------------------------------------------------


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


def build_app(
    world: World, granted: Principal, users: InMemoryUserRepository | None = None
) -> FastAPI:
    app = app_with_principal(granted)
    app.include_router(
        create_generations_router(world.service, act_as=ActAs(users or InMemoryUserRepository()))
    )
    return app


def client(app: FastAPI) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver")


def new_rows(world: World, seeded: set[uuid.UUID]) -> list[GenerationJob]:
    return [job for job in world.repo.jobs.values() if job.id not in seeded]


async def test_transcribing_ones_own_take_takes_attribution_from_the_request() -> None:
    owner, conversation, task = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    take = completed_take(owner_user_id=owner, conversation_id=conversation)
    world = build_world([take])
    async with client(build_app(world, principal("generation:submit", user_id=owner))) as http:
        response = await http.post(
            "/generations/subtitles",
            json={
                "sourceJobId": str(take.id),
                "conversationId": str(conversation),
                "taskId": str(task),
                "metadata": {"film": "整片"},
            },
        )

    assert response.status_code == 202, response.text
    (subtitle,) = world.subtitles()
    generation = response.json()["generation"]
    assert generation["id"] == str(subtitle.id)
    assert (generation["kind"], generation["status"], generation["sourceUrl"]) == (
        "subtitle",
        "pending",
        TAKE_URL,
    )
    assert generation["sentences"] is None and generation["outputUrl"] is None
    assert (subtitle.owner_user_id, subtitle.conversation_id, subtitle.task_id) == (
        owner,
        conversation,
        task,
    )
    assert subtitle.metadata == {"film": "整片"}
    assert subtitle.request == SubtitleRequest(model=MODEL, video_url=TAKE_URL)
    assert len(world.submits_to(FAKE_SUBTITLE_PROVIDER)) == 1
    assert world.cleared.calls == [], "识别不是在对话里动手，不动收尾标记"


@pytest.mark.parametrize("readable", [True, False], ids=["读得到副本", "读不到副本"])
async def test_an_inherited_take_can_be_transcribed_into_the_fork_only_when_readable(
    readable: bool,
) -> None:
    forker, source, fork = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    forked_at = datetime.now(UTC)
    inherited = completed_take(
        conversation_id=source,
        created_at=forked_at - timedelta(minutes=2),
        finished_at=forked_at - timedelta(minutes=1),
    )
    world = build_world(
        [inherited], lineage=FixedLineage({fork: ((source, forked_at),)}, readable=readable)
    )
    async with client(build_app(world, principal("generation:submit", user_id=forker))) as http:
        response = await http.post(
            "/generations/subtitles",
            json={"sourceJobId": str(inherited.id), "conversationId": str(fork)},
        )

    assert response.status_code == (202 if readable else 404), response.text
    if readable:
        (subtitle,) = world.subtitles()
        assert (subtitle.conversation_id, subtitle.owner_user_id, subtitle.source_job_id) == (
            fork,
            forker,
            inherited.id,
        ), "记在副本名下，来源是源对话里那条"
    else:
        assert world.subtitles() == []


@pytest.mark.parametrize("case", ["不存在", "别人的", "别的对话里的"])
async def test_a_video_the_caller_cannot_read_here_is_404(case: str) -> None:
    me, conversation = uuid.uuid4(), uuid.uuid4()
    take = completed_take(
        owner_user_id=uuid.uuid4() if case == "别人的" else me,
        conversation_id=uuid.uuid4() if case == "别的对话里的" else conversation,
    )
    world = build_world([take])
    target = uuid.uuid4() if case == "不存在" else take.id
    async with client(build_app(world, principal("generation:submit", user_id=me))) as http:
        response = await http.post(
            "/generations/subtitles",
            json={"sourceJobId": str(target), "conversationId": str(conversation)},
        )

    assert response.status_code == 404, response.text
    assert world.subtitles() == []


@pytest.mark.parametrize("kind", ["编辑段", "图片", "没完成的出片", "失败的出片", "字幕记录"])
async def test_a_readable_record_that_is_not_a_master_is_rejected(kind: str) -> None:
    me = uuid.uuid4()
    take = completed_take(owner_user_id=me)
    target = {
        "编辑段": replace(make_edit(take), status=STATUS_COMPLETED, output_url=TAKE_URL),
        "图片": make_job(
            image_request(), owner_user_id=me, status=STATUS_COMPLETED, output_url="https://a/b.png"
        ),
        "没完成的出片": make_job(video_request(), owner_user_id=me, status=STATUS_SUBMITTED),
        "失败的出片": make_job(video_request(), owner_user_id=me, status=STATUS_FAILED),
        "字幕记录": make_subtitle(take, status=STATUS_COMPLETED, sentences=SENTENCES),
    }[kind]
    target = replace(target, owner_user_id=me, conversation_id=None)
    world = build_world([take, target])
    seeded = set(world.repo.jobs)
    async with client(build_app(world, principal("generation:submit", user_id=me))) as http:
        response = await http.post("/generations/subtitles", json={"sourceJobId": str(target.id)})

    assert response.status_code == 422, response.text
    assert "成片" in response.json()["detail"]
    assert new_rows(world, seeded) == []


async def test_manual_transcription_is_refused_when_subtitles_are_not_configured() -> None:
    me = uuid.uuid4()
    take = completed_take(owner_user_id=me)
    world = build_world([take], subtitles=None)
    async with client(build_app(world, principal("generation:submit", user_id=me))) as http:
        response = await http.post("/generations/subtitles", json={"sourceJobId": str(take.id)})

    assert response.status_code == 422, response.text
    assert "没有开通" in response.json()["detail"]
    assert world.subtitles() == []


async def test_manual_transcription_settles_the_author_like_other_submits() -> None:
    """钥匙不报名字就拒；持 users:act_as 的钥匙报了名字，属主换成那个人；浏览器只能报自己。"""

    users = InMemoryUserRepository()
    sara = await users.ensure_by_name("Sara.Hong", email=placeholder_email("Sara.Hong"))
    take = completed_take(owner_user_id=sara)
    world = build_world([take])
    key = api_key("generation:submit", ACT_AS_PERMISSION)
    body = {"sourceJobId": str(take.id)}
    async with client(build_app(world, key, users)) as http:
        nameless = await http.post("/generations/subtitles", json=body)
        acting = await http.post("/generations/subtitles", json={**body, "userName": "Sara.Hong"})
    async with client(build_app(world, principal("generation:submit", user_id=sara))) as http:
        someone_else = await http.post("/generations/subtitles", json={**body, "userName": "bob"})

    assert nameless.status_code == 422
    assert acting.status_code == 202, acting.text
    (subtitle,) = world.subtitles()
    assert (subtitle.owner_user_id, subtitle.api_key_id) == (sara, key.api_key_id)
    assert someone_else.status_code == 422


async def test_manual_transcription_needs_the_submit_permission() -> None:
    take = completed_take()
    world = build_world([take])
    async with client(build_app(world, principal("generation:read"))) as http:
        response = await http.post("/generations/subtitles", json={"sourceJobId": str(take.id)})

    assert response.status_code == 403


# --- 读取 -----------------------------------------------------------------------


@pytest.mark.parametrize("sentences", [SENTENCES, ()], ids=["有口播", "没有口播"])
async def test_a_finished_subtitle_record_reads_back_its_sentences_by_kind_source_and_conversation(
    sentences: tuple[SubtitleSentence, ...],
) -> None:
    me, conversation = uuid.uuid4(), uuid.uuid4()
    take = completed_take(owner_user_id=me, conversation_id=conversation)
    subtitle = make_subtitle(
        take, status=STATUS_COMPLETED, sentences=sentences, finished_at=datetime.now(UTC)
    )
    world = build_world([take, subtitle])
    async with client(build_app(world, principal("generation:read", user_id=me))) as http:
        single = await http.get(f"/generations/{subtitle.id}")
        by_kind = await http.get(f"/generations?kind=subtitle&sourceJobId={take.id}")
        by_conversation = await http.get(f"/generations?conversationId={conversation}")
        as_video_task = await http.get(f"/generations/video/{subtitle.id}")

    assert single.status_code == 200, single.text
    generation = single.json()["generation"]
    expected = (
        [
            {"startMs": 100, "endMs": 1800, "text": "第一句。", "speaker": 0},
            {"startMs": 2000, "endMs": 3000, "text": "第二句。", "speaker": None},
        ]
        if sentences
        else []
    )
    assert generation["status"] == STATUS_COMPLETED
    assert generation["sentences"] == expected
    assert (generation["outputUrl"], generation["sourceJobId"], generation["sourceUrl"]) == (
        None,
        str(take.id),
        TAKE_URL,
    )
    assert [item["id"] for item in by_kind.json()["items"]] == [str(subtitle.id)]
    assert by_kind.json()["items"][0]["sentences"] == expected
    assert by_kind.json()["items"][0]["status"] == STATUS_COMPLETED
    assert {item["id"] for item in by_conversation.json()["items"]} == {
        str(take.id),
        str(subtitle.id),
    }
    assert as_video_task.status_code == 404, "字幕记录不是视频任务"
