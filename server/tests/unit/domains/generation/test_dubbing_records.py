from __future__ import annotations

import uuid
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from procrastinate.testing import InMemoryConnector

from iclip.domains.generation.api import create_generations_router
from iclip.domains.generation.model_groups import UNGROUPED, ModelGroup, ModelGroups
from iclip.domains.generation.models import (
    STATUS_COMPLETED,
    GenerationJob,
    GenerationOutput,
)
from iclip.domains.generation.nano_banana import NANO_BANANA_PRO
from iclip.domains.generation.ports import VoiceSample
from iclip.domains.generation.provider import ProviderSubmission
from iclip.domains.generation.queue import GenerationQueue, ProviderLane, submit_queue
from iclip.domains.generation.schemas import (
    MAX_DUBBING_LINE_CHARS,
    MAX_DUBBING_LINES,
    DubbedLine,
    DubbingLine,
    DubbingOriginalReference,
    DubbingReference,
    DubbingRequest,
    DubbingUploadReference,
    DubbingVoiceReference,
)
from iclip.domains.generation.service import GenerationService
from iclip.domains.identity.acting import ActAs
from iclip.domains.identity.models import Principal
from tests.helpers.app import app_with_principal
from tests.helpers.generation import (
    FAKE_DUBBING_PROVIDER,
    FAKE_IMAGE_PROVIDER,
    FAKE_VIDEO_PROVIDER,
    QUEUE_SETTINGS,
    FakeMediaProbe,
    FakeReferenceAssets,
    FixedLineage,
    InMemoryGenerationRepository,
    ScriptedProvider,
    make_dubbing,
    make_edit,
    make_job,
    make_music,
    trial_request,
    video_request,
)
from tests.helpers.identity import InMemoryUserRepository

TAKE_URL = "https://cdn.example.test/iclip/agent/video-masters/take.mp4"
TAKE_MS = 8_000
DUBBING_URL = "https://cdn.example.test/iclip/agent/generated-dubbing/d.m4a"
VOICE_URL = "https://cdn.example.test/iclip/agent/uploads/voice.wav"
UPLOAD_URL = "https://cdn.example.test/iclip/agent/uploads/mine.m4a"

LINES: list[dict[str, Any]] = [
    {"startMs": 500, "endMs": 2_000, "text": "Hello there."},
    {"startMs": 2_500, "endMs": 5_000, "text": "These shoes are light."},
]


@dataclass
class World:
    repo: InMemoryGenerationRepository
    queue: GenerationQueue
    connector: InMemoryConnector
    service: GenerationService
    probe: FakeMediaProbe

    def dubbings(self) -> list[GenerationJob]:
        return [job for job in self.repo.jobs.values() if job.kind == "dubbing"]

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
    dubbing: str | None = FAKE_DUBBING_PROVIDER,
    references: FakeReferenceAssets | None = None,
    submission: ProviderSubmission | None = None,
    durations: dict[str, int] | None = None,
    model_groups: ModelGroups = UNGROUPED,
) -> World:
    store = InMemoryGenerationRepository(jobs)
    providers = (
        ScriptedProvider(name=FAKE_VIDEO_PROVIDER),
        ScriptedProvider(name="ffmpeg"),
        ScriptedProvider(name=FAKE_IMAGE_PROVIDER),
        ScriptedProvider(name=FAKE_DUBBING_PROVIDER, submission=submission),
    )
    connector = InMemoryConnector()
    queue = GenerationQueue(
        store,
        lanes=tuple(ProviderLane(provider, 1) for provider in providers),
        connector=connector,
        settings=QUEUE_SETTINGS,
    )
    probe = FakeMediaProbe(durations)

    async def keep(_conversation_id: uuid.UUID, _owner: uuid.UUID) -> None:
        return None

    service = GenerationService(
        store,
        queue,
        video_provider_name=FAKE_VIDEO_PROVIDER,
        compose_provider_name="ffmpeg",
        video_default_model="vendor-a-seedance-2-5",
        video_allowed_models=("vendor-a-seedance-2-5",),
        image_models={"nano_banana_pro": NANO_BANANA_PRO.spec},
        image_default_model="nano_banana_pro",
        clear_completion=keep,
        lineage=FixedLineage(),
        media_probe=probe,
        references=references or FakeReferenceAssets(),
        dubbing_provider=dubbing,
        model_groups=model_groups,
    )
    return World(store, queue, connector, service, probe)


def completed_take(**fields: Any) -> GenerationJob:
    fields.setdefault("output", GenerationOutput(url=TAKE_URL, duration_ms=TAKE_MS))
    fields.setdefault("finished_at", datetime.now(UTC))
    return make_job(video_request(), status=STATUS_COMPLETED, **fields)


def principal(*permissions: str, user_id: uuid.UUID) -> Principal:
    return Principal(
        kind="user",
        user_id=user_id,
        permissions=frozenset(permissions),
        audit_label="tester",
        username="tester",
    )


def client(world: World, granted: Principal) -> httpx.AsyncClient:
    app: FastAPI = app_with_principal(granted)
    app.include_router(
        create_generations_router(world.service, act_as=ActAs(InMemoryUserRepository()))
    )
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver")


def body(take: GenerationJob, **overrides: Any) -> dict[str, Any]:
    return {
        "sourceJobId": str(take.id),
        "locale": "en",
        "lines": LINES,
        "reference": {"kind": "original"},
        **overrides,
    }


async def post(world: World, me: uuid.UUID, payload: dict[str, Any]) -> httpx.Response:
    async with client(world, principal("generation:submit", user_id=me)) as http:
        return await http.post("/generations/dubbings", json=payload)


async def test_dubbing_a_take_records_the_lines_reference_and_video_length_and_queues_it() -> None:
    me, conversation, task = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    take = completed_take(owner_user_id=me, conversation_id=conversation)
    world = build_world([take])

    response = await post(
        world,
        me,
        body(
            take,
            conversationId=str(conversation),
            taskId=str(task),
            metadata={"locale": "en"},
        ),
    )

    assert response.status_code == 202, response.text
    (dubbing,) = world.dubbings()
    generation = response.json()["generation"]
    assert (generation["id"], generation["kind"], generation["status"]) == (
        str(dubbing.id),
        "dubbing",
        "pending",
    )
    assert (generation["sourceUrl"], generation["outputUrl"], generation["dubbedLines"]) == (
        TAKE_URL,
        None,
        None,
    )
    assert (dubbing.source_job_id, dubbing.conversation_id, dubbing.task_id) == (
        take.id,
        conversation,
        task,
    )
    assert dubbing.request == DubbingRequest(
        video_url=TAKE_URL,
        video_duration_ms=TAKE_MS,
        locale="en",
        lines=[
            DubbingLine(start_ms=500, end_ms=2_000, text="Hello there."),
            DubbingLine(start_ms=2_500, end_ms=5_000, text="These shoes are light."),
        ],
        reference=DubbingOriginalReference(kind="original"),
    )
    assert len(world.submits_to(FAKE_DUBBING_PROVIDER)) == 1


@pytest.mark.parametrize("group", ["mkt", None], ids=["grouped", "default"])
async def test_a_dubbing_records_the_owners_model_group_on_acceptance(group: str | None) -> None:
    me = uuid.uuid4()
    take = completed_take(owner_user_id=me)

    async def group_of(user_id: uuid.UUID) -> str | None:
        return group if user_id == me else None

    groups = ModelGroups(
        (ModelGroup(name="mkt", video_api_key="vk-mkt", video_models={}),), group_of=group_of
    )
    world = build_world([take], model_groups=groups)

    response = await post(world, me, body(take))

    assert response.status_code == 202, response.text
    (dubbing,) = world.dubbings()
    assert dubbing.model_group == group


async def test_a_take_without_a_recorded_length_is_measured_before_accepting() -> None:
    me = uuid.uuid4()
    take = completed_take(owner_user_id=me, output=GenerationOutput(url=TAKE_URL))
    world = build_world([take], durations={TAKE_URL: 4_000})

    accepted = await post(world, me, body(take, lines=LINES[:1]))
    too_long = await post(world, me, body(take))

    assert accepted.status_code == 202, accepted.text
    (dubbing,) = world.dubbings()
    assert isinstance(dubbing.request, DubbingRequest)
    assert dubbing.request.video_duration_ms == 4_000
    assert too_long.status_code == 422, "第二句结尾 5 秒超出了 4 秒的素材片"
    assert world.probe.probed == [TAKE_URL, TAKE_URL]


VOICE_ID = uuid.UUID("00000000-0000-4000-8000-00000000a0ce")
UPLOAD_ID = uuid.UUID("00000000-0000-4000-8000-0000000001ad")


def _assets(me: uuid.UUID) -> FakeReferenceAssets:
    return FakeReferenceAssets(
        voices={VOICE_ID: VoiceSample(url=VOICE_URL, transcript="你好，欢迎光临。")},
        audio_uploads={(me, UPLOAD_ID): UPLOAD_URL},
    )


@pytest.mark.parametrize(
    ("reference", "recorded"),
    [
        ({"kind": "original"}, DubbingOriginalReference(kind="original")),
        (
            {"kind": "reference_audio", "referenceId": str(VOICE_ID)},
            DubbingVoiceReference(
                kind="reference_audio",
                reference_id=VOICE_ID,
                url=VOICE_URL,
                transcript="你好，欢迎光临。",
            ),
        ),
        (
            {"kind": "upload", "uploadId": str(UPLOAD_ID)},
            DubbingUploadReference(kind="upload", upload_id=UPLOAD_ID, url=UPLOAD_URL),
        ),
    ],
    ids=["原声", "参考音频库的音色", "本人的音频上传"],
)
async def test_each_kind_of_reference_is_recorded_with_the_address_it_resolves_to(
    reference: dict[str, str], recorded: DubbingReference
) -> None:
    me = uuid.uuid4()
    take = completed_take(owner_user_id=me)
    world = build_world([take], references=_assets(me))

    response = await post(world, me, body(take, reference=reference))

    assert response.status_code == 202, response.text
    (dubbing,) = world.dubbings()
    assert isinstance(dubbing.request, DubbingRequest)
    assert dubbing.request.reference == recorded
    assert response.json()["generation"]["request"]["reference"] == recorded.model_dump(
        mode="json", by_alias=True
    )


@pytest.mark.parametrize(
    "reference",
    [
        {"kind": "reference_audio", "referenceId": str(uuid.uuid4())},
        {"kind": "upload", "uploadId": str(uuid.uuid4())},
        {"kind": "audio", "url": VOICE_URL},
    ],
    ids=["不在库里、移除了或不是音色", "不是本人的音频上传", "旧的按地址给"],
)
async def test_a_reference_that_does_not_resolve_is_rejected(reference: dict[str, str]) -> None:
    me = uuid.uuid4()
    take = completed_take(owner_user_id=me)
    world = build_world([take], references=_assets(me))

    response = await post(world, me, body(take, reference=reference))

    assert response.status_code == 422, response.text
    assert world.dubbings() == []


async def test_dubbing_is_refused_when_no_speech_synthesizer_is_wired() -> None:
    me = uuid.uuid4()
    take = completed_take(owner_user_id=me)
    world = build_world([take], dubbing=None)

    response = await post(world, me, body(take))

    assert response.status_code == 422, response.text
    assert "没有开通" in response.json()["detail"]
    assert world.dubbings() == []


@pytest.mark.parametrize("case", ["不存在", "别人的"])
async def test_a_video_the_caller_cannot_read_is_404(case: str) -> None:
    me = uuid.uuid4()
    take = completed_take(owner_user_id=uuid.uuid4() if case == "别人的" else me)
    world = build_world([take])
    target = uuid.uuid4() if case == "不存在" else take.id

    response = await post(world, me, body(take, sourceJobId=str(target)))

    assert response.status_code == 404, response.text
    assert world.dubbings() == []


@pytest.mark.parametrize("kind", ["编辑段", "背景音乐", "配音记录", "试生成"])
async def test_a_readable_record_that_is_not_a_master_is_rejected(kind: str) -> None:
    me = uuid.uuid4()
    take = completed_take(owner_user_id=me)
    target = {
        "编辑段": replace(
            make_edit(take), status=STATUS_COMPLETED, output=GenerationOutput(url=TAKE_URL)
        ),
        "试生成": make_job(
            trial_request(),
            status=STATUS_COMPLETED,
            output=GenerationOutput(url=TAKE_URL, duration_ms=TAKE_MS),
            finished_at=datetime.now(UTC),
        ),
        "背景音乐": make_music(
            status=STATUS_COMPLETED, output=GenerationOutput(url=DUBBING_URL, duration_ms=TAKE_MS)
        ),
        "配音记录": make_dubbing(
            take,
            [DubbingLine(start_ms=0, end_ms=1_000, text="Hi")],
            duration_ms=TAKE_MS,
            status=STATUS_COMPLETED,
            output=GenerationOutput(url=DUBBING_URL, duration_ms=TAKE_MS),
        ),
    }[kind]
    target = replace(target, owner_user_id=me, conversation_id=None)
    world = build_world([take, target])
    seeded = set(world.repo.jobs)

    response = await post(world, me, body(take, sourceJobId=str(target.id)))

    assert response.status_code == 422, response.text
    assert "素材片" in response.json()["detail"]
    assert set(world.repo.jobs) == seeded


def _line(start: int, end: int, text: str = "Hi") -> dict[str, Any]:
    return {"startMs": start, "endMs": end, "text": text}


@pytest.mark.parametrize(
    "lines",
    [
        [],
        [_line(1_000, 1_000)],
        [_line(2_000, 1_000)],
        [_line(0, 1_000, "   ")],
        [_line(0, 2_000), _line(1_500, 3_000)],
        [_line(3_000, 4_000), _line(0, 1_000)],
        [_line(0, 1_000, "a" * (MAX_DUBBING_LINE_CHARS + 1))],
        [_line(index * 10, index * 10 + 5) for index in range(MAX_DUBBING_LINES + 1)],
        [_line(index * 800, index * 800 + 400, "a" * 500) for index in range(9)],
        [_line(0, 1_000), _line(TAKE_MS, TAKE_MS + 10)],
        [_line(0, 1_000), _line(7_000, TAKE_MS + 100)],
    ],
    ids=[
        "一句都没有",
        "没有长度",
        "结尾早于开始",
        "只有空白",
        "重叠",
        "没按时间排",
        "一句超字数",
        "超句数",
        "总字数超",
        "开始不在素材片里",
        "结尾超出素材片",
    ],
)
async def test_lines_that_break_the_rules_are_rejected(lines: list[dict[str, Any]]) -> None:
    me = uuid.uuid4()
    take = completed_take(owner_user_id=me)
    world = build_world([take])

    response = await post(world, me, body(take, lines=lines))

    assert response.status_code == 422, response.text
    assert world.dubbings() == []


async def test_a_line_may_end_a_hair_past_the_take_like_an_edit_range() -> None:
    me = uuid.uuid4()
    take = completed_take(owner_user_id=me)
    world = build_world([take])

    response = await post(world, me, body(take, lines=[_line(7_000, TAKE_MS + 50)]))

    assert response.status_code == 202, response.text


async def test_a_finished_dubbing_reads_back_its_track_and_per_line_results() -> None:
    me, conversation = uuid.uuid4(), uuid.uuid4()
    take = completed_take(owner_user_id=me, conversation_id=conversation)
    dubbing = make_dubbing(
        take,
        [DubbingLine(start_ms=500, end_ms=2_000, text="Hello there.")],
        duration_ms=TAKE_MS,
    )
    music = make_music(owner_user_id=me, conversation_id=conversation, status=STATUS_COMPLETED)
    results = (
        DubbedLine(index=0, speed=1.0, trimmed=False),
        DubbedLine(index=1, speed=1.25, trimmed=True),
    )
    world = build_world(
        [take, dubbing, music],
        submission=ProviderSubmission(
            provider_task_id=str(dubbing.id),
            provider_status="succeeded",
            output_url=DUBBING_URL,
            duration_ms=TAKE_MS,
            dubbed_lines=results,
        ),
    )

    await world.queue.run_submit(str(dubbing.id))
    async with client(world, principal("generation:read", user_id=me)) as http:
        single = await http.get(f"/generations/{dubbing.id}")
        by_kind = await http.get(f"/generations?kind=dubbing&sourceJobId={take.id}")
        as_music = await http.get(f"/generations?kind=audio&conversationId={conversation}")

    assert single.status_code == 200, single.text
    generation = single.json()["generation"]
    assert (generation["status"], generation["outputUrl"], generation["durationMs"]) == (
        STATUS_COMPLETED,
        DUBBING_URL,
        TAKE_MS,
    )
    assert generation["dubbedLines"] == [
        {"index": 0, "speed": 1.0, "trimmed": False},
        {"index": 1, "speed": 1.25, "trimmed": True},
    ]
    assert generation["sentences"] is None
    assert [item["id"] for item in by_kind.json()["items"]] == [str(dubbing.id)]
    assert [item["id"] for item in as_music.json()["items"]] == [str(music.id)], (
        "配音不混进背景音乐"
    )
