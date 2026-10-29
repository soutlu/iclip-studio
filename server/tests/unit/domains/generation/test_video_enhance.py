"""高清版（超分）的两个端点：提交一档高清版，与读一条视频能做的各档。

用内存仓储与真实队列协程，provider 是替身，不碰上游。"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
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
    STATUS_SUBMITTED,
    GenerationJob,
    GenerationOutput,
)
from iclip.domains.generation.queue import submit_queue
from iclip.domains.generation.schemas import VideoEnhanceRequest
from iclip.domains.generation.service import GenerationService, VideoEnhanceSpec
from iclip.domains.identity.acting import ActAs, placeholder_email
from iclip.domains.identity.models import Principal
from iclip.domains.identity.rbac import ACT_AS_PERMISSION
from tests.helpers.app import app_with_principal
from tests.helpers.generation import (
    FAKE_VIDEO_PROVIDER,
    FakeMediaProbe,
    FixedLineage,
    InMemoryGenerationRepository,
    build_queue,
    image_request,
    make_composite,
    make_edit,
    make_enhancement,
    make_job,
    make_subtitle,
    make_upload,
    video_request,
    whole_film_request,
)
from tests.helpers.identity import InMemoryUserRepository

ENHANCE = VideoEnhanceSpec(model="video-enhance", resolutions=("1080p", "720p"), fps=30)
URL = "/generations/video-enhancements"
NOW = datetime(2026, 10, 20, 9, 0, tzinfo=UTC)


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


SUBMITTER = principal("generation:submit", "generation:read")
READER = principal("generation:read")


class Cleared:
    def __init__(self) -> None:
        self.calls: list[tuple[uuid.UUID, uuid.UUID]] = []

    async def record(self, conversation_id: uuid.UUID, owner: uuid.UUID) -> None:
        self.calls.append((conversation_id, owner))


def build_app(
    repo: InMemoryGenerationRepository,
    *,
    granted: Principal | None,
    enhance: VideoEnhanceSpec | None = ENHANCE,
    users: InMemoryUserRepository | None = None,
) -> FastAPI:
    """``app.state.connector`` 是排队的去处，``app.state.cleared`` 记下抹过哪些对话的收尾标记。"""

    app = app_with_principal(granted)
    queue, connector = build_queue(repo)
    cleared = Cleared()
    app.state.connector = connector
    app.state.cleared = cleared
    service = GenerationService(
        repo,
        queue,
        video_provider_name=FAKE_VIDEO_PROVIDER,
        compose_provider_name="ffmpeg",
        video_default_model="vendor-a-seedance-2-5",
        video_allowed_models=("vendor-a-seedance-2-5",),
        image_models={},
        image_default_model="nano_banana_pro",
        clear_completion=cleared.record,
        lineage=FixedLineage(),
        media_probe=FakeMediaProbe(),
        enhance=enhance,
    )
    app.include_router(
        create_generations_router(service, act_as=ActAs(users or InMemoryUserRepository()))
    )
    return app


def client(app: FastAPI) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver")


def submits(app: FastAPI) -> list[dict[str, Any]]:
    connector: InMemoryConnector = app.state.connector
    return [dict(row) for row in connector.jobs.values() if row["task_name"] == "generation.submit"]


def take(resolution: str | None = "720p", **fields: Any) -> GenerationJob:
    """一条别人在别的对话里出的已完成素材片，默认 720p、第 3 镜。"""

    fields.setdefault("status", STATUS_COMPLETED)
    fields.setdefault("finished_at", NOW)
    fields.setdefault("conversation_id", uuid.uuid4())
    fields.setdefault("shot_index", 3)
    fields.setdefault(
        "output",
        GenerationOutput(
            url=f"https://cdn.test/take-{uuid.uuid4()}.mp4",
            watermark_url="https://cdn.test/take-wm.mp4",
        ),
    )
    return make_job(video_request(resolution=resolution), **fields)


def composite_of(original: GenerationJob) -> GenerationJob:
    return make_composite(
        make_edit(
            original,
            status=STATUS_COMPLETED,
            output=GenerationOutput(url="https://cdn.test/edit.mp4"),
        ),
        status=STATUS_COMPLETED,
        finished_at=NOW,
        output=GenerationOutput(url=f"https://cdn.test/composite-{uuid.uuid4()}.mp4"),
    )


def film(*sources: GenerationJob, **fields: Any) -> GenerationJob:
    fields.setdefault("status", STATUS_COMPLETED)
    fields.setdefault("finished_at", NOW)
    fields.setdefault("conversation_id", uuid.uuid4())
    fields.setdefault("output", GenerationOutput(url=f"https://cdn.test/film-{uuid.uuid4()}.mp4"))
    return make_job(whole_film_request(*(source.id for source in sources)), **fields)


def new_rows(repo: InMemoryGenerationRepository, seeded: set[uuid.UUID]) -> list[GenerationJob]:
    return [job for job_id, job in repo.jobs.items() if job_id not in seeded]


# --- 提交 ------------------------------------------------------------------------


async def test_a_take_gets_an_enhancement_queued_on_the_video_lane() -> None:
    """来源是别人在别的对话里的素材片也提得了；记录是视频、不挂对话、没有原作，镜号抄来源，
    请求是配置的模型与帧率、来源的原片地址；排进视频那条队列，不碰任何对话的收尾标记。"""

    source = take("720p", owner_user_id=uuid.uuid4(), task_id=uuid.uuid4(), metadata={"k": 1})
    repo = InMemoryGenerationRepository([source])
    app = build_app(repo, granted=SUBMITTER)
    async with client(app) as http:
        response = await http.post(URL, json={"sourceJobId": str(source.id), "resolution": "1080p"})

    assert response.status_code == 202, response.text
    (job,) = new_rows(repo, {source.id})
    assert (job.kind, job.operation, job.status) == ("video", "enhance", STATUS_PENDING)
    assert (job.source_job_id, job.root_job_id, job.shot_index) == (source.id, None, 3)
    assert (job.conversation_id, job.task_id, job.metadata) == (None, None, None)
    assert (job.owner_user_id, job.provider) == (SUBMITTER.user_id, FAKE_VIDEO_PROVIDER)
    assert job.request == VideoEnhanceRequest(
        model="video-enhance",
        resolution="1080p",
        fps=30,
        video_url=str(source.output.url),
        user_name="tester",
    )
    assert [row["queue_name"] for row in submits(app)] == [submit_queue(FAKE_VIDEO_PROVIDER)]
    assert app.state.cleared.calls == []
    generation = response.json()["generation"]
    assert (generation["id"], generation["kind"], generation["operation"]) == (
        str(job.id),
        "video",
        "enhance",
    )
    assert (generation["sourceJobId"], generation["sourceUrl"]) == (
        str(source.id),
        source.output.url,
    )
    assert generation["request"] == {
        "model": "video-enhance",
        "resolution": "1080p",
        "fps": 30,
        "video_url": source.output.url,
        "user_name": "tester",
    }


async def test_a_whole_film_gets_a_video_enhancement() -> None:
    """高清版产出的总是一个视频：成片的高清版种类也是视频，来源是那次导出。"""

    first = take("480p")
    exported = film(first)
    repo = InMemoryGenerationRepository([first, exported])
    async with client(build_app(repo, granted=SUBMITTER)) as http:
        response = await http.post(
            URL, json={"sourceJobId": str(exported.id), "resolution": "720p"}
        )

    assert response.status_code == 202, response.text
    (job,) = new_rows(repo, {first.id, exported.id})
    assert (job.kind, job.operation, job.source_job_id) == ("video", "enhance", exported.id)
    assert (job.conversation_id, job.shot_index) == (None, None)
    assert isinstance(job.request, VideoEnhanceRequest)
    assert job.request.video_url == exported.output.url


async def test_enhance_not_switched_on_is_refused_without_storing() -> None:
    source = take()
    repo = InMemoryGenerationRepository([source])
    app = build_app(repo, granted=SUBMITTER, enhance=None)
    async with client(app) as http:
        response = await http.post(URL, json={"sourceJobId": str(source.id), "resolution": "1080p"})

    assert response.status_code == 422
    assert "高清版没有开通" in response.json()["detail"]
    assert list(repo.jobs) == [source.id]
    assert submits(app) == []


async def test_a_missing_source_is_a_404() -> None:
    repo = InMemoryGenerationRepository()
    async with client(build_app(repo, granted=SUBMITTER)) as http:
        response = await http.post(
            URL, json={"sourceJobId": str(uuid.uuid4()), "resolution": "1080p"}
        )

    assert response.status_code == 404
    assert repo.jobs == {}


def _ineligible() -> list[tuple[str, Callable[[GenerationJob], GenerationJob]]]:
    return [
        (
            "edit",
            lambda base: make_edit(
                base, status=STATUS_COMPLETED, output=GenerationOutput(url="https://x/e.mp4")
            ),
        ),
        ("unfinished_take", lambda _: take(status=STATUS_SUBMITTED, output=GenerationOutput())),
        ("failed_take", lambda _: take(status=STATUS_FAILED, output=GenerationOutput())),
        ("video_upload", lambda _: make_upload(kind="video")),
        (
            "image",
            lambda _: make_job(
                image_request(),
                status=STATUS_COMPLETED,
                output=GenerationOutput(url="https://x/i.png"),
            ),
        ),
        ("subtitle", lambda base: make_subtitle(base, status=STATUS_COMPLETED)),
        (
            "unfinished_film",
            lambda base: film(base, status=STATUS_SUBMITTED, output=GenerationOutput()),
        ),
        ("enhancement", lambda base: make_enhancement(base, status=STATUS_COMPLETED)),
    ]


@pytest.mark.parametrize(
    "make_source", [maker for _, maker in _ineligible()], ids=[name for name, _ in _ineligible()]
)
async def test_only_masters_and_finished_films_can_be_enhanced(
    make_source: Callable[[GenerationJob], GenerationJob],
) -> None:
    base = take("480p")
    source = make_source(base)
    repo = InMemoryGenerationRepository([base, source])
    async with client(build_app(repo, granted=SUBMITTER)) as http:
        response = await http.post(URL, json={"sourceJobId": str(source.id), "resolution": "1080p"})

    assert response.status_code == 422, response.text
    assert set(repo.jobs) == {base.id, source.id}


@pytest.mark.parametrize(
    ("source_resolution", "asked"),
    [("1080p", "1080p"), ("1080p", "720p"), ("720p", "720p")],
)
async def test_a_tier_no_sharper_than_the_source_is_refused(
    source_resolution: str, asked: str
) -> None:
    source = take(source_resolution)
    repo = InMemoryGenerationRepository([source])
    async with client(build_app(repo, granted=SUBMITTER)) as http:
        response = await http.post(URL, json={"sourceJobId": str(source.id), "resolution": asked})

    assert response.status_code == 422, response.text
    assert list(repo.jobs) == [source.id]


async def test_a_tier_outside_what_upstream_takes_is_a_422() -> None:
    source = take("480p")
    repo = InMemoryGenerationRepository([source])
    async with client(build_app(repo, granted=SUBMITTER)) as http:
        response = await http.post(URL, json={"sourceJobId": str(source.id), "resolution": "4k"})

    assert response.status_code == 422
    assert list(repo.jobs) == [source.id]


@pytest.mark.parametrize("status", [STATUS_PENDING, STATUS_SUBMITTED, STATUS_COMPLETED])
async def test_an_unfailed_enhancement_of_the_same_tier_is_handed_back_whoever_asked(
    status: str,
) -> None:
    """别人已经提过、还没失败的那一条直接给回来：照样 202，不新建、不排队。"""

    source = take("480p")
    theirs = make_enhancement(source, "1080p", status=status, owner_user_id=uuid.uuid4())
    other_tier = make_enhancement(source, "720p", status=status)
    repo = InMemoryGenerationRepository([source, theirs, other_tier])
    app = build_app(repo, granted=SUBMITTER)
    async with client(app) as http:
        response = await http.post(URL, json={"sourceJobId": str(source.id), "resolution": "1080p"})

    assert response.status_code == 202, response.text
    assert response.json()["generation"]["id"] == str(theirs.id)
    assert set(repo.jobs) == {source.id, theirs.id, other_tier.id}
    assert submits(app) == []


async def test_a_failed_enhancement_can_be_asked_for_again() -> None:
    source = take("480p")
    failed = make_enhancement(source, "1080p", status=STATUS_FAILED, error_code="X")
    elsewhere = make_enhancement(take("480p"), "1080p", status=STATUS_PENDING)
    repo = InMemoryGenerationRepository([source, failed, elsewhere])
    app = build_app(repo, granted=SUBMITTER)
    async with client(app) as http:
        response = await http.post(URL, json={"sourceJobId": str(source.id), "resolution": "1080p"})

    assert response.status_code == 202, response.text
    (job,) = new_rows(repo, {source.id, failed.id, elsewhere.id})
    assert response.json()["generation"]["id"] == str(job.id)
    assert repo.jobs[failed.id].status == STATUS_FAILED, "失败的那条留着"
    assert len(submits(app)) == 1


async def test_the_author_is_settled_like_a_video_edit() -> None:
    """钥匙不报名字就拒；持 users:act_as 的钥匙报了名字，属主换成那个人；浏览器只能报自己。"""

    source = take("480p")
    repo = InMemoryGenerationRepository([source])
    users = InMemoryUserRepository()
    sara = await users.ensure_by_name("Sara.Hong", email=placeholder_email("Sara.Hong"))
    key = api_key("generation:submit", ACT_AS_PERMISSION)
    body: dict[str, object] = {"sourceJobId": str(source.id), "resolution": "1080p"}
    async with client(build_app(repo, granted=key, users=users)) as http:
        nameless = await http.post(URL, json=body)
        acting = await http.post(URL, json={**body, "userName": "Sara.Hong"})
    async with client(build_app(repo, granted=SUBMITTER)) as http:
        someone_else = await http.post(URL, json={**body, "resolution": "720p", "userName": "bob"})

    assert nameless.status_code == 422
    assert acting.status_code == 202, acting.text
    (job,) = new_rows(repo, {source.id})
    assert job.owner_user_id == sara, "属主换成报上来的那个人"
    assert job.api_key_id == key.api_key_id
    assert isinstance(job.request, VideoEnhanceRequest)
    assert job.request.user_name == "Sara.Hong"
    assert someone_else.status_code == 422


async def test_submitting_needs_the_submit_permission() -> None:
    source = take("480p")
    repo = InMemoryGenerationRepository([source])
    async with client(build_app(repo, granted=READER)) as http:
        response = await http.post(URL, json={"sourceJobId": str(source.id), "resolution": "1080p"})

    assert response.status_code == 403
    assert list(repo.jobs) == [source.id]


# --- 读各档 ----------------------------------------------------------------------


async def read(
    repo: InMemoryGenerationRepository,
    job_id: uuid.UUID,
    *,
    enhance: VideoEnhanceSpec | None = ENHANCE,
    granted: Principal = READER,
) -> httpx.Response:
    async with client(build_app(repo, granted=granted, enhance=enhance)) as http:
        return await http.get(f"/generations/{job_id}/enhancements")


def tiers_of(response: httpx.Response) -> list[str]:
    assert response.status_code == 200, response.text
    return [tier["resolution"] for tier in response.json()["tiers"]]


@pytest.mark.parametrize(
    ("resolution", "tiers"),
    [
        ("480p", ["1080p", "720p"]),
        ("720p", ["1080p"]),
        ("1080p", []),
        (None, ["1080p", "720p"]),
        ("2k", ["1080p", "720p"]),
    ],
)
async def test_tiers_are_the_configured_ones_sharper_than_the_take(
    resolution: str | None, tiers: list[str]
) -> None:
    """按配置的先后列比来源清晰的；来源清晰度认不出（没写或别的写法）就全列，让上游去拒。"""

    source = take(resolution)
    assert tiers_of(await read(InMemoryGenerationRepository([source]), source.id)) == tiers


async def test_a_composite_is_judged_by_its_original_take() -> None:
    original = take("720p")
    composite = composite_of(original)
    repo = InMemoryGenerationRepository([original, composite])

    assert tiers_of(await read(repo, composite.id)) == ["1080p"]


@pytest.mark.parametrize(
    ("first", "tiers"),
    [("720p", ["1080p"]), ("480p", ["1080p", "720p"]), ("1080p", [])],
)
async def test_a_whole_film_is_judged_by_its_first_video(first: str, tiers: list[str]) -> None:
    lead, later = take(first), take("1080p" if first != "1080p" else "480p")
    exported = film(lead, later)
    repo = InMemoryGenerationRepository([lead, later, exported])

    assert tiers_of(await read(repo, exported.id)) == tiers


async def test_a_whole_film_led_by_a_composite_follows_that_composites_original() -> None:
    original = take("1080p")
    composite = composite_of(original)
    exported = film(composite, take("480p"))
    repo = InMemoryGenerationRepository([original, composite, exported])

    assert tiers_of(await read(repo, exported.id)) == []


async def test_a_whole_film_without_videos_lists_every_tier() -> None:
    exported = film()
    assert tiers_of(await read(InMemoryGenerationRepository([exported]), exported.id)) == [
        "1080p",
        "720p",
    ]


async def test_each_tier_carries_its_most_recent_enhancement_by_anyone() -> None:
    source = take("480p")
    older = make_enhancement(
        source, "1080p", status=STATUS_COMPLETED, owner_user_id=uuid.uuid4(), created_at=NOW
    )
    newer = make_enhancement(
        source,
        "1080p",
        status=STATUS_FAILED,
        owner_user_id=uuid.uuid4(),
        created_at=NOW + timedelta(minutes=1),
        error_code="X",
        error_message="不行",
    )
    unrelated = make_subtitle(source, status=STATUS_COMPLETED)
    repo = InMemoryGenerationRepository([source, older, newer, unrelated])

    response = await read(repo, source.id)

    assert response.status_code == 200, response.text
    body = response.json()
    assert [(tier["resolution"], tier["job"] and tier["job"]["id"]) for tier in body["tiers"]] == [
        ("1080p", str(newer.id)),
        ("720p", None),
    ]
    assert body["tiers"][0]["job"]["sourceUrl"] == source.output.url


async def test_each_tier_says_whether_its_record_is_the_readers() -> None:
    """``mine`` 只看这一档最近那条的属主是不是读的人；没有记录为 false。"""

    reader = principal("generation:read")
    source = take("480p")
    others = take("480p")
    own = make_enhancement(source, "1080p", owner_user_id=reader.user_id)
    theirs = make_enhancement(others, "1080p", owner_user_id=uuid.uuid4())
    repo = InMemoryGenerationRepository([source, others, own, theirs])

    mine = await read(repo, source.id, granted=reader)
    not_mine = await read(repo, others.id, granted=reader)

    assert [(tier["resolution"], tier["mine"]) for tier in mine.json()["tiers"]] == [
        ("1080p", True),
        ("720p", False),
    ]
    assert [(tier["resolution"], tier["mine"]) for tier in not_mine.json()["tiers"]] == [
        ("1080p", False),
        ("720p", False),
    ]


async def test_downloads_count_against_the_take_or_the_films_videos() -> None:
    lead, later = take("720p"), take("480p")
    exported = film(lead, later)
    repo = InMemoryGenerationRepository([lead, later, exported])

    video = await read(repo, lead.id)
    whole = await read(repo, exported.id)

    assert video.json()["downloadedJobIds"] == [str(lead.id)]
    assert whole.json()["downloadedJobIds"] == [str(lead.id), str(later.id)]


async def test_a_source_that_cannot_be_enhanced_has_nothing_to_offer() -> None:
    base = take("480p")
    edit = make_edit(
        base, status=STATUS_COMPLETED, output=GenerationOutput(url="https://cdn.test/e.mp4")
    )
    repo = InMemoryGenerationRepository([base, edit])

    response = await read(repo, edit.id)

    assert response.status_code == 200
    assert response.json() == {"downloadedJobIds": [], "tiers": []}


async def test_without_enhance_switched_on_there_are_no_tiers() -> None:
    source = take("480p")
    response = await read(InMemoryGenerationRepository([source]), source.id, enhance=None)

    assert response.status_code == 200
    assert response.json() == {"downloadedJobIds": [str(source.id)], "tiers": []}


async def test_reading_tiers_of_a_missing_record_is_a_404() -> None:
    response = await read(InMemoryGenerationRepository(), uuid.uuid4())
    assert response.status_code == 404


async def test_reading_tiers_needs_the_read_permission() -> None:
    source = take("480p")
    response = await read(
        InMemoryGenerationRepository([source]), source.id, granted=principal("generation:submit")
    )
    assert response.status_code == 403
