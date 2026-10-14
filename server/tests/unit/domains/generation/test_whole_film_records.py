"""整片的受理与它在生成记录里的位置：端点（202 与信封、时间线校验、段与音乐的出处、读不到 404、代办与
权限），整片不能当基底，完成后照常排字幕记录。

用内存仓储与真实队列协程，provider 全是替身，不碰 ffmpeg。"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from procrastinate.testing import InMemoryConnector

from iclip.domains.generation.api import create_generations_router
from iclip.domains.generation.models import STATUS_COMPLETED, STATUS_PENDING, GenerationJob
from iclip.domains.generation.nano_banana import NANO_BANANA_PRO
from iclip.domains.generation.provider import ProviderSubmission
from iclip.domains.generation.queue import GenerationQueue, ProviderLane, submit_queue
from iclip.domains.generation.schemas import (
    KIND_AUDIO,
    KIND_VIDEO,
    MAX_COMPOSE_SEGMENTS,
    MAX_MUSIC_GAIN_POINTS,
    MAX_WHOLE_FILM_MS,
    MAX_WHOLE_FILM_SUBTITLE_CHARS,
    WholeFilmMusic,
    WholeFilmRender,
    WholeFilmRequest,
    WholeFilmSegment,
    WholeFilmSubtitle,
)
from iclip.domains.generation.service import GenerationService, MusicTarget, SubtitleTarget
from iclip.domains.identity.acting import ActAs, placeholder_email
from iclip.domains.identity.models import Principal
from iclip.domains.identity.rbac import ACT_AS_PERMISSION
from tests.helpers.app import app_with_principal
from tests.helpers.generation import (
    FAKE_IMAGE_PROVIDER,
    FAKE_MUSIC_PROVIDER,
    FAKE_SUBTITLE_PROVIDER,
    FAKE_VIDEO_PROVIDER,
    QUEUE_SETTINGS,
    FixedLineage,
    InMemoryGenerationRepository,
    ScriptedProvider,
    image_request,
    make_composite,
    make_edit,
    make_job,
    make_music,
    make_upload,
    make_whole_film,
    video_request,
)
from tests.helpers.identity import InMemoryUserRepository

TAKE_URL = "https://cdn.test/take.mp4"
FILM_URL = "https://cdn.test/iclip/agent/video-masters/film.mp4"
MUSIC_URL = "https://cdn.test/iclip/agent/generated-music/m.m4a"
UPLOADED_MUSIC_URL = "https://cdn.test/iclip/agent/uploads/song.mp3"


class _ClearedCompletions:
    def __init__(self) -> None:
        self.calls: list[tuple[uuid.UUID, uuid.UUID]] = []

    async def record(self, conversation_id: uuid.UUID, owner: uuid.UUID) -> None:
        self.calls.append((conversation_id, owner))


async def _no_probe(url: str) -> int:
    raise AssertionError("整片受理时不探时长")


@dataclass
class World:
    repo: InMemoryGenerationRepository
    queue: GenerationQueue
    connector: InMemoryConnector
    service: GenerationService
    cleared: _ClearedCompletions

    def films(self) -> list[GenerationJob]:
        return [job for job in self.repo.jobs.values() if isinstance(job.request, WholeFilmRequest)]

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
    lineage: FixedLineage | None = None,
    compose_submission: ProviderSubmission | None = None,
) -> World:
    """真队列与真服务：字幕识别开着，完成回调接到服务上，与装配一致。"""

    store = InMemoryGenerationRepository(jobs)
    lanes = tuple(
        ProviderLane(provider, 1)
        for provider in (
            ScriptedProvider(name=FAKE_VIDEO_PROVIDER),
            ScriptedProvider(name="ffmpeg", submission=compose_submission),
            ScriptedProvider(name=FAKE_IMAGE_PROVIDER),
            ScriptedProvider(name=FAKE_SUBTITLE_PROVIDER),
            ScriptedProvider(name=FAKE_MUSIC_PROVIDER),
        )
    )
    connector = InMemoryConnector()
    cleared = _ClearedCompletions()
    holder: dict[str, GenerationService] = {}

    async def on_completed(job: GenerationJob) -> None:
        await holder["service"].transcribe_completed(job)

    queue = GenerationQueue(
        store, lanes=lanes, connector=connector, settings=QUEUE_SETTINGS, on_completed=on_completed
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
        probe_duration_ms=_no_probe,
        subtitles=SubtitleTarget(provider=FAKE_SUBTITLE_PROVIDER, model="qwen-audio-3.1-asr-flash"),
        music=MusicTarget(provider=FAKE_MUSIC_PROVIDER, model="qwen-audio-3.1-tts-next"),
    )
    holder["service"] = service
    return World(store, queue, connector, service, cleared)


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
    world: World, granted: Principal | None, users: InMemoryUserRepository | None = None
) -> httpx.AsyncClient:
    app: FastAPI = app_with_principal(granted)
    app.include_router(
        create_generations_router(world.service, act_as=ActAs(users or InMemoryUserRepository()))
    )
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver")


def completed_take(**fields: Any) -> GenerationJob:
    fields.setdefault("output_url", TAKE_URL)
    fields.setdefault("watermark_output_url", "https://cdn.test/take-wm.mp4")
    fields.setdefault("finished_at", datetime.now(UTC))
    return make_job(video_request(), status=STATUS_COMPLETED, **fields)


def completed_film(*masters: GenerationJob, **fields: Any) -> GenerationJob:
    fields.setdefault("output_url", FILM_URL)
    fields.setdefault("finished_at", datetime.now(UTC))
    return make_whole_film(*masters, status=STATUS_COMPLETED, **fields)


def generated_music(**fields: Any) -> GenerationJob:
    fields.setdefault("output_url", MUSIC_URL)
    fields.setdefault("finished_at", datetime.now(UTC))
    fields.setdefault("duration_ms", 30_000)
    return make_music(status=STATUS_COMPLETED, **fields)


def segment(job: GenerationJob, start_ms: int = 0, end_ms: int = 1000) -> dict[str, Any]:
    return {"sourceJobId": str(job.id), "startMs": start_ms, "endMs": end_ms}


def body(conversation: uuid.UUID, *segments: dict[str, Any], **extra: Any) -> dict[str, Any]:
    return {
        "conversationId": str(conversation),
        "segments": list(segments),
        "subtitles": [],
        **extra,
    }


# --- 受理 -----------------------------------------------------------------------


async def test_a_whole_film_is_recorded_as_a_sourceless_compose_with_its_whole_timeline() -> None:
    me, conversation, task = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    take = completed_take(owner_user_id=me, conversation_id=conversation, shot_index=1)
    edit = make_edit(take, owner_user_id=me, conversation_id=conversation, status=STATUS_COMPLETED)
    composite = make_composite(
        edit,
        owner_user_id=me,
        conversation_id=conversation,
        status=STATUS_COMPLETED,
        output_url="https://cdn.test/composite.mp4",
        finished_at=datetime.now(UTC),
        duration_ms=5000,
    )
    music = generated_music(owner_user_id=me, conversation_id=conversation)
    world = build_world([take, edit, composite, music])
    subtitles = [
        {"startMs": 0, "endMs": 800, "text": "第一句"},
        {"startMs": 800, "endMs": 2500, "text": "第二句"},
    ]
    gain = [{"atMs": 0, "gain": 1}, {"atMs": 500, "gain": 0.3}]
    async with client(world, principal("generation:submit", user_id=me)) as http:
        response = await http.post(
            "/generations/whole-films",
            json=body(
                conversation,
                segment(take, 0, 1000),
                segment(composite, 2000, 4000),
                segment(take, 3000, 3500),
                subtitles=subtitles,
                music={"audioJobId": str(music.id), "offsetMs": 1500, "gain": gain},
                taskId=str(task),
                metadata={"film": "整片"},
            ),
        )

    assert response.status_code == 202, response.text
    (film,) = world.films()
    generation = response.json()["generation"]
    assert (generation["id"], generation["kind"], generation["operation"]) == (
        str(film.id),
        "video",
        "compose",
    )
    assert generation["status"] == STATUS_PENDING
    assert (generation["sourceJobId"], generation["rootJobId"], generation["shotIndex"]) == (
        None,
        None,
        None,
    )
    assert (film.owner_user_id, film.conversation_id, film.task_id, film.metadata) == (
        me,
        conversation,
        task,
        {"film": "整片"},
    )
    assert film.request == WholeFilmRequest(
        segments=[
            WholeFilmSegment(source_job_id=take.id, url=TAKE_URL, start_ms=0, end_ms=1000),
            WholeFilmSegment(
                source_job_id=composite.id,
                url="https://cdn.test/composite.mp4",
                start_ms=2000,
                end_ms=4000,
            ),
            WholeFilmSegment(source_job_id=take.id, url=TAKE_URL, start_ms=3000, end_ms=3500),
        ],
        subtitles=[WholeFilmSubtitle.model_validate(item) for item in subtitles],
        music=WholeFilmMusic.model_validate(
            {"audioJobId": music.id, "url": MUSIC_URL, "offsetMs": 1500, "gain": gain}
        ),
        render=WholeFilmRender(),
    ), "出处换成产物地址，字幕与曲线原样，声音参数是受理时的常量"
    assert generation["request"]["render"] == {
        "speechLoudnessLufs": -16.0,
        "musicLoudnessLufs": -16.0,
        "loudnessLufs": -14.0,
        "peakDbfs": -1.5,
        "segmentFadeMs": 50,
        "musicFadeOutMs": 2000,
    }
    assert len(world.submits_to("ffmpeg")) == 1, "走合成那条 lane"
    assert world.cleared.calls == [(conversation, me)], "和合成一样抹收尾标记"


@pytest.mark.parametrize(
    ("shape", "accepted"),
    [
        (dict(segments=[]), False),
        (dict(segments=[(0, 1000)] * MAX_COMPOSE_SEGMENTS), True),
        (dict(segments=[(0, 1000)] * (MAX_COMPOSE_SEGMENTS + 1)), False),
        (dict(segments=[(1000, 1000)]), False),
        (dict(segments=[(60_000, 120_000), (0, 60_000)]), True),
        (dict(segments=[(60_000, 120_000), (0, 60_001)]), False),
        (dict(subtitles=[(0, 500, "a"), (500, 1000, "b")]), True),
        (dict(subtitles=[(0, 600, "a"), (500, 1000, "b")]), False),
        (dict(subtitles=[(500, 1000, "b"), (0, 400, "a")]), False),
        (dict(subtitles=[(0, 2001, "a")]), False),
        (dict(subtitles=[(500, 500, "a")]), False),
        (dict(subtitles=[(0, 500, "")]), False),
        (dict(subtitles=[(0, 500, " \n ")]), False),
        (dict(subtitles=[(0, 500, "字" * MAX_WHOLE_FILM_SUBTITLE_CHARS)]), True),
        (dict(subtitles=[(0, 500, "字" * (MAX_WHOLE_FILM_SUBTITLE_CHARS + 1))]), False),
        (dict(subtitles=None), False),
        (dict(gain=[]), False),
        (dict(gain=[(0, 1.0), (0, 0.5)]), False),
        (dict(gain=[(500, 1.0), (0, 0.5)]), False),
        (dict(gain=[(0, 1.5)]), False),
        (dict(gain=[(0, -0.1)]), False),
        (dict(gain=[(0, 1.0), (2000, 0.0)]), True),
        (dict(gain=[(0, 1.0), (2001, 0.0)]), False),
        (dict(gain=[(index, 1.0) for index in range(MAX_MUSIC_GAIN_POINTS)]), True),
        (dict(gain=[(index, 1.0) for index in range(MAX_MUSIC_GAIN_POINTS + 1)]), False),
        (dict(conversation=None), False),
    ],
    ids=[
        "没有段",
        "正好 100 段",
        "101 段",
        "段的结尾不晚于起点",
        "正好 120 秒",
        "超过 120 秒",
        "字幕首尾相接",
        "字幕重叠",
        "字幕没按先后排",
        "字幕超出整片",
        "字幕起止相同",
        "字幕文字为空",
        "字幕全是空白",
        "字幕正好 200 字",
        "字幕超过 200 字",
        "没给字幕",
        "曲线没有点",
        "曲线时刻重复",
        "曲线时刻倒退",
        "音量大于 1",
        "音量小于 0",
        "曲线正好到整片结尾",
        "曲线超出整片",
        "曲线正好 500 个点",
        "曲线 501 个点",
        "没给对话",
    ],
)
async def test_the_timeline_is_checked_on_input(shape: dict[str, Any], accepted: bool) -> None:
    """默认是一段 2 秒的整片：每段取一条没量过时长的出片，段的结尾不在受理时判。"""

    conversation = uuid.uuid4()
    me = uuid.uuid4()
    take = completed_take(owner_user_id=me, conversation_id=conversation)
    music = generated_music(owner_user_id=me, conversation_id=conversation, duration_ms=None)
    world = build_world([take, music])
    spans = shape.get("segments", [(0, 2000)])
    payload: dict[str, Any] = {
        "segments": [segment(take, start, end) for start, end in spans],
    }
    lines = shape.get("subtitles", [])
    if lines is not None:
        payload["subtitles"] = [
            {"startMs": start, "endMs": end, "text": text} for start, end, text in lines
        ]
    if shape.get("conversation", conversation) is not None:
        payload["conversationId"] = str(conversation)
    if "gain" in shape:
        payload["music"] = {
            "audioJobId": str(music.id),
            "offsetMs": 0,
            "gain": [{"atMs": at, "gain": gain} for at, gain in shape["gain"]],
        }
    async with client(world, principal("generation:submit", user_id=me)) as http:
        response = await http.post("/generations/whole-films", json=payload)

    assert response.status_code == (202 if accepted else 422), response.text
    assert len(world.films()) == (1 if accepted else 0)


def test_the_film_length_limit_is_in_the_contract() -> None:
    """前端从生成物读 120 秒：整片时间上的字段以它为上限。"""

    schema = WholeFilmSubtitle.model_json_schema(by_alias=True)
    assert schema["properties"]["endMs"]["maximum"] == MAX_WHOLE_FILM_MS == 120_000


async def test_a_conversation_the_caller_cannot_read_is_404() -> None:
    take = completed_take()
    world = build_world([take], lineage=FixedLineage(readable=False))
    async with client(world, principal("generation:submit", user_id=take.owner_user_id)) as http:
        response = await http.post(
            "/generations/whole-films",
            json=body(take.conversation_id or uuid.uuid4(), segment(take)),
        )

    assert response.status_code == 404, response.text
    assert world.films() == []


# --- 段的出处 -------------------------------------------------------------------


@pytest.mark.parametrize("case", ["不存在", "别人的", "别的对话里的", "上传"])
async def test_a_segment_source_the_caller_cannot_read_here_is_404(case: str) -> None:
    me, conversation = uuid.uuid4(), uuid.uuid4()
    take = (
        make_upload(kind=KIND_VIDEO, owner_user_id=me, output_url=TAKE_URL)
        if case == "上传"
        else completed_take(
            owner_user_id=uuid.uuid4() if case == "别人的" else me,
            conversation_id=uuid.uuid4() if case == "别的对话里的" else conversation,
        )
    )
    world = build_world([take])
    source = (
        {**segment(take), "sourceJobId": str(uuid.uuid4())} if case == "不存在" else segment(take)
    )
    async with client(world, principal("generation:submit", user_id=me)) as http:
        response = await http.post("/generations/whole-films", json=body(conversation, source))

    assert response.status_code == 404, response.text
    assert world.films() == []


@pytest.mark.parametrize("case", ["整片", "编辑段", "没完成的出片", "图片"])
async def test_a_segment_source_that_is_not_a_take_or_composite_is_422(case: str) -> None:
    me, conversation = uuid.uuid4(), uuid.uuid4()
    take = completed_take(owner_user_id=me, conversation_id=conversation)
    candidates = {
        "整片": completed_film(take),
        "编辑段": make_edit(
            take,
            owner_user_id=me,
            conversation_id=conversation,
            status=STATUS_COMPLETED,
            output_url="https://cdn.test/edit.mp4",
        ),
        "没完成的出片": make_job(video_request(), owner_user_id=me, conversation_id=conversation),
        "图片": make_job(
            image_request(),
            owner_user_id=me,
            conversation_id=conversation,
            status=STATUS_COMPLETED,
            output_url="https://cdn.test/a.png",
        ),
    }
    source = candidates[case]
    world = build_world([take, source])
    async with client(world, principal("generation:submit", user_id=me)) as http:
        response = await http.post(
            "/generations/whole-films", json=body(conversation, segment(take), segment(source))
        )

    assert response.status_code == 422, response.text
    assert "整片的每段必须取自一条已完成的出片或合成" in response.json()["detail"]
    assert len(world.repo.jobs) == 2, "不建记录"


async def test_a_segment_ending_past_its_measured_source_is_422() -> None:
    me, conversation = uuid.uuid4(), uuid.uuid4()
    take = completed_take(owner_user_id=me, conversation_id=conversation, duration_ms=5000)
    world = build_world([take])
    async with client(world, principal("generation:submit", user_id=me)) as http:
        within = await http.post(
            "/generations/whole-films", json=body(conversation, segment(take, 4000, 5050))
        )
        past = await http.post(
            "/generations/whole-films", json=body(conversation, segment(take, 4000, 5051))
        )

    assert within.status_code == 202, "容差 50 毫秒，同合成"
    assert past.status_code == 422, past.text
    assert len(world.films()) == 1


@pytest.mark.parametrize("readable", [True, False], ids=["读得到副本", "读不到副本"])
async def test_an_inherited_take_can_be_cut_into_the_forks_film(readable: bool) -> None:
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
    async with client(world, principal("generation:submit", user_id=forker)) as http:
        response = await http.post("/generations/whole-films", json=body(fork, segment(inherited)))

    assert response.status_code == (202 if readable else 404), response.text
    if readable:
        (film,) = world.films()
        assert (film.conversation_id, film.owner_user_id) == (fork, forker)


# --- 音乐 -----------------------------------------------------------------------


def _music_body(
    conversation: uuid.UUID, take: GenerationJob, music: GenerationJob, offset_ms: int = 0
) -> dict[str, Any]:
    return body(
        conversation,
        segment(take, 0, 2000),
        music={
            "audioJobId": str(music.id),
            "offsetMs": offset_ms,
            "gain": [{"atMs": 0, "gain": 1}],
        },
    )


@pytest.mark.parametrize(
    ("case", "status"),
    [
        ("自己上传的", 202),
        ("这段对话生成的", 202),
        ("继承来的生成音乐", 202),
        ("别人上传的", 404),
        ("别的对话生成的", 404),
        ("不存在", 404),
        ("一条视频", 422),
        ("没生成完的", 422),
    ],
)
async def test_the_music_must_be_a_finished_audio_record_the_caller_can_use_here(
    case: str, status: int
) -> None:
    me, source, conversation = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    forked_at = datetime.now(UTC)
    take = completed_take(owner_user_id=me, conversation_id=conversation)
    music = {
        "自己上传的": make_upload(kind=KIND_AUDIO, owner_user_id=me, output_url=UPLOADED_MUSIC_URL),
        "这段对话生成的": generated_music(owner_user_id=me, conversation_id=conversation),
        "继承来的生成音乐": generated_music(
            conversation_id=source,
            created_at=forked_at - timedelta(minutes=2),
            finished_at=forked_at - timedelta(minutes=1),
        ),
        "别人上传的": make_upload(kind=KIND_AUDIO, output_url=UPLOADED_MUSIC_URL),
        "别的对话生成的": generated_music(owner_user_id=me),
        "不存在": generated_music(owner_user_id=me, conversation_id=conversation),
        "一条视频": completed_take(owner_user_id=me, conversation_id=conversation),
        "没生成完的": make_music(owner_user_id=me, conversation_id=conversation),
    }[case]
    world = build_world(
        [take] if case == "不存在" else [take, music],
        lineage=FixedLineage({conversation: ((source, forked_at),)}),
    )
    async with client(world, principal("generation:submit", user_id=me)) as http:
        response = await http.post(
            "/generations/whole-films", json=_music_body(conversation, take, music)
        )

    assert response.status_code == status, response.text
    if status == 202:
        (film,) = world.films()
        assert isinstance(film.request, WholeFilmRequest)
        assert film.request.music is not None
        assert (film.request.music.audio_job_id, film.request.music.url) == (
            music.id,
            music.output_url,
        )
    else:
        assert world.films() == []


async def test_music_shorter_than_the_film_from_its_offset_is_refused_when_its_length_is_known() -> (
    None
):
    """生成的音乐量过时长，受理时就判；上传的没量过，交给执行方判。"""

    me, conversation = uuid.uuid4(), uuid.uuid4()
    take = completed_take(owner_user_id=me, conversation_id=conversation)
    music = generated_music(owner_user_id=me, conversation_id=conversation, duration_ms=10_000)
    upload = make_upload(kind=KIND_AUDIO, owner_user_id=me, output_url=UPLOADED_MUSIC_URL)
    world = build_world([take, music, upload])
    async with client(world, principal("generation:submit", user_id=me)) as http:
        fits = await http.post(
            "/generations/whole-films", json=_music_body(conversation, take, music, 8000)
        )
        short = await http.post(
            "/generations/whole-films", json=_music_body(conversation, take, music, 8001)
        )
        unknown = await http.post(
            "/generations/whole-films", json=_music_body(conversation, take, upload, 60_000)
        )

    assert fits.status_code == 202, fits.text
    assert short.status_code == 422, short.text
    assert "不够整片" in short.json()["detail"]
    assert unknown.status_code == 202, unknown.text


# --- 代办与权限 ------------------------------------------------------------------


async def test_a_whole_film_settles_the_author_like_other_submits() -> None:
    """钥匙不报名字就拒；持 users:act_as 的钥匙报了名字，属主换成那个人，段与音乐按他读；名字不进请求。"""

    users = InMemoryUserRepository()
    sara = await users.ensure_by_name("Sara.Hong", email=placeholder_email("Sara.Hong"))
    conversation = uuid.uuid4()
    take = completed_take(owner_user_id=sara, conversation_id=conversation)
    upload = make_upload(kind=KIND_AUDIO, owner_user_id=sara, output_url=UPLOADED_MUSIC_URL)
    world = build_world([take, upload])
    key = api_key("generation:submit", ACT_AS_PERMISSION)
    payload = _music_body(conversation, take, upload)
    async with client(world, key, users) as http:
        nameless = await http.post("/generations/whole-films", json=payload)
        acting = await http.post(
            "/generations/whole-films", json={**payload, "userName": "Sara.Hong"}
        )

    assert nameless.status_code == 422
    assert acting.status_code == 202, acting.text
    (film,) = world.films()
    assert (film.owner_user_id, film.api_key_id) == (sara, key.api_key_id)
    assert "userName" not in acting.json()["generation"]["request"]


async def test_a_whole_film_needs_the_submit_permission_and_a_caller() -> None:
    take = completed_take(conversation_id=uuid.uuid4())
    world = build_world([take])
    payload = body(take.conversation_id or uuid.uuid4(), segment(take))
    async with client(world, principal("generation:read")) as http:
        forbidden = await http.post("/generations/whole-films", json=payload)
    async with client(world, None) as http:
        anonymous = await http.post("/generations/whole-films", json=payload)

    assert (forbidden.status_code, anonymous.status_code) == (403, 401)
    assert world.films() == []


# --- 整片不能当基底 ----------------------------------------------------------------


async def test_a_whole_film_cannot_be_the_base_of_an_edit_or_a_composite() -> None:
    me, conversation = uuid.uuid4(), uuid.uuid4()
    take = completed_take(owner_user_id=me, conversation_id=conversation)
    film = completed_film(take)
    world = build_world([take, film])
    async with client(world, principal("generation:submit", user_id=me)) as http:
        edit = await http.post(
            "/generations/video-edits",
            json={
                "source_job_id": str(film.id),
                "range_start_ms": 0,
                "range_end_ms": 1000,
                "reference_video_urls": ["https://cdn.test/iclip/agent/uploads/clip.mp4"],
                "model": "vendor-a-seedance-2-5",
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
    assert len(world.repo.jobs) == 2, "都不建记录"


# --- 完成之后 -------------------------------------------------------------------


async def test_a_finished_whole_film_is_transcribed_like_any_master() -> None:
    take = completed_take(conversation_id=uuid.uuid4(), task_id=uuid.uuid4())
    film = make_whole_film(take, task_id=take.task_id)
    world = build_world(
        [take, film],
        compose_submission=ProviderSubmission(
            provider_task_id=str(film.id),
            provider_status="completed",
            output_url=FILM_URL,
            duration_ms=1000,
        ),
    )

    await world.queue.run_submit(str(film.id))

    stored = world.repo.jobs[film.id]
    assert (stored.status, stored.output_url, stored.duration_ms) == (
        STATUS_COMPLETED,
        FILM_URL,
        1000,
    )
    (subtitle,) = [job for job in world.repo.jobs.values() if job.kind == "subtitle"]
    assert (subtitle.source_job_id, subtitle.conversation_id, subtitle.task_id) == (
        film.id,
        film.conversation_id,
        film.task_id,
    )
