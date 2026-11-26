from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import Callable, Mapping
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

import httpx
import pytest
from procrastinate.testing import InMemoryConnector

from iclip.domains.generation.models import (
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_SUBMITTED,
    GenerationJob,
    GenerationOutput,
)
from iclip.domains.generation.module import (
    GenerationModule,
    ImageModelConfig,
    build_generation_module,
)
from iclip.domains.generation.queue import GenerationQueueSettings
from iclip.domains.generation.schemas import (
    ComposeSegmentIn,
    VideoComposeIn,
    VideoEditIn,
    VideoEditRequest,
)
from iclip.domains.generation.video import VideoProviderSettings
from iclip.domains.identity.acting import ActAs
from iclip.domains.identity.models import Principal
from iclip.platform.media.codec import SOFTWARE
from iclip.platform.media.process import ffmpeg_available
from iclip.platform.object_store.layout import MEDIA_PATHS
from iclip.platform.object_store.store import ObjectStoreUnavailable
from tests.helpers.fetch_url import as_is, rewriting
from tests.helpers.generation import (
    FakeReferenceAssets,
    FixedLineage,
    InMemoryGenerationRepository,
    MemoryObjectStore,
    make_job,
    stored_request,
    video_request,
)
from tests.helpers.identity import InMemoryUserRepository
from tests.helpers.media import duration_ms_of, synthesize_video
from tests.helpers.media_server import serving
from tests.helpers.model_groups import default_only

pytestmark = [
    pytest.mark.anyio,
    pytest.mark.skipif(not ffmpeg_available(), reason="本机 PATH 上没有 ffmpeg/ffprobe"),
]

MODEL = "vendor-a-seedance-2-5"

FRAME_MS = 100

PRINCIPAL = Principal(
    kind="user",
    user_id=uuid.uuid4(),
    permissions=frozenset({"generation:submit"}),
    audit_label="tester",
    username="tester",
)


async def _keep_completion(_conversation_id: uuid.UUID, _owner: uuid.UUID) -> None:
    return None


def _edit_module(
    repo: InMemoryGenerationRepository,
    sent: list[dict[str, Any]],
    *,
    store: MemoryObjectStore,
    fetch_url: Callable[[str], str] = as_is,
    queue_settings: GenerationQueueSettings | None = None,
) -> GenerationModule:
    def upstream(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        return httpx.Response(200, json={"task_id": "upstream-1"})

    return build_generation_module(
        repo,
        act_as=ActAs(InMemoryUserRepository()),
        clear_completion=_keep_completion,
        lineage=FixedLineage(),
        references=FakeReferenceAssets(),
        video=VideoProviderSettings(
            submit_url="https://video.test/generate",
            status_base_url="https://video.test/tasks",
        ),
        video_default_model=MODEL,
        video_allowed_models=(MODEL,),
        image_models=[
            ImageModelConfig(name="nano_banana_pro", api_base="https://image.test", concurrency=1)
        ],
        image_default_model="nano_banana_pro",
        image_env="test",
        image_text_to_image_task="text-to-image",
        image_edit_task="image-edit",
        object_store=store,
        public_url=store.public_url,
        queue_connector=InMemoryConnector(),
        media_codec=SOFTWARE,
        fetch_url=fetch_url,
        queue_settings=queue_settings,
        model_groups=default_only((MODEL,)),
        video_transport=httpx.MockTransport(upstream),
    )


def _edit_in(source_job_id: uuid.UUID, *, start_ms: int, end_ms: int) -> VideoEditIn:
    return VideoEditIn(
        mode="edit",
        source_job_id=source_job_id,
        range_start_ms=start_ms,
        range_end_ms=end_ms,
        model=MODEL,
        prompt="换一双鞋",
        user_name="tester",
    )


def _base_video(seconds: int = 6) -> bytes:
    with TemporaryDirectory(prefix="edit-fixture-") as tmp:
        return synthesize_video(Path(tmp) / "base.mp4", size="320x240", seconds=seconds, audio=True)


def _plant_take(
    repo: InMemoryGenerationRepository, url: str, *, duration_ms: int | None = None
) -> GenerationJob:
    take = make_job(
        video_request(),
        status=STATUS_COMPLETED,
        owner_user_id=PRINCIPAL.user_id,
        output=GenerationOutput(url=url, duration_ms=duration_ms),
    )
    repo.jobs[take.id] = take
    return take


@pytest.mark.parametrize(
    ("start_ms", "end_ms", "clip_ms"),
    [(1000, 5000, 4000), (2000, 6040, 4000)],
    ids=["区间在基底之内", "终点超出基底时切到基底结尾"],
)
async def test_an_edit_cuts_its_reference_from_the_base_before_going_upstream(
    start_ms: int, end_ms: int, clip_ms: int
) -> None:
    repo = InMemoryGenerationRepository()
    store = MemoryObjectStore()
    sent: list[dict[str, Any]] = []
    async with serving({"base.mp4": _base_video()}) as server:
        module = _edit_module(repo, sent, store=store)
        take = _plant_take(repo, server.url("base.mp4"))
        job = await module.service.submit_video_edit(
            PRINCIPAL, _edit_in(take.id, start_ms=start_ms, end_ms=end_ms)
        )
        clip_key = MEDIA_PATHS.edit_reference(job_id=job.id)
        clip_url = store.public_url(clip_key)
        request = stored_request(job)
        assert isinstance(request, VideoEditRequest)
        assert request.reference_video_urls == [clip_url], "受理时就记下这条编辑段的片段地址"
        assert store.objects == {}, "受理时不切段"

        await module.queue.run_submit(str(job.id))

    edit = repo.jobs[job.id]
    assert edit.status == STATUS_SUBMITTED, edit.error_message
    content, content_type = store.objects[clip_key]
    assert content_type == "video/mp4"
    assert abs(await duration_ms_of(content) - clip_ms) <= FRAME_MS, "按区间精确切出参考片段"
    (body,) = sent
    assert body["reference_video_urls"] == [clip_url], "上游拿到的就是切好的片段"
    assert (body["seconds"], body["user_name"], body["prompt"]) == (-1, "tester", "换一双鞋")
    assert "mode" not in body, "生成方式不发上游"
    request = stored_request(edit)
    assert isinstance(request, VideoEditRequest)
    assert (request.range_start_ms, request.range_end_ms) == (start_ms, end_ms), "区间原样记"


async def test_the_base_is_fetched_at_its_rewritten_address() -> None:
    public = "https://cdn.test"
    base_url = f"{public}/iclip/agent/base.mp4"
    repo = InMemoryGenerationRepository()
    store = MemoryObjectStore()
    sent: list[dict[str, Any]] = []
    async with serving({"iclip/agent/base.mp4": _base_video()}) as server:
        module = _edit_module(repo, sent, store=store, fetch_url=rewriting(public, server.base_url))
        take = _plant_take(repo, base_url)
        job = await module.service.submit_video_edit(
            PRINCIPAL, _edit_in(take.id, start_ms=1000, end_ms=5000)
        )
        await module.queue.run_submit(str(job.id))

    assert repo.jobs[job.id].status == STATUS_SUBMITTED, repo.jobs[job.id].error_message
    assert {delivery.target for delivery in server.deliveries} == {"iclip/agent/base.mp4"}
    (body,) = sent
    assert body["reference_video_urls"] == [
        store.public_url(MEDIA_PATHS.edit_reference(job_id=job.id))
    ], "交给上游的是桶的公网地址"


class _UnavailableStore(MemoryObjectStore):
    async def put_public_object(
        self,
        *,
        object_key: str,
        content: bytes,
        content_type: str,
        metadata: Mapping[str, str] | None = None,
    ) -> str:
        raise ObjectStoreUnavailable("桶暂时连不上")


@pytest.mark.parametrize(
    ("served", "store", "code"),
    [
        ({}, MemoryObjectStore(), "MEDIA_SOURCE_UNREACHABLE"),
        ({"base.mp4": b"not a video"}, MemoryObjectStore(), "MEDIA_PROCESS_FAILED"),
        (None, _UnavailableStore(), "OUTPUT_STORE_FAILED"),
    ],
    ids=["取不到基底", "基底切不了", "存不进桶"],
)
async def test_a_failed_cut_fails_the_edit_without_going_upstream(
    served: dict[str, bytes] | None, store: MemoryObjectStore, code: str
) -> None:
    repo = InMemoryGenerationRepository()
    sent: list[dict[str, Any]] = []
    async with serving({"base.mp4": _base_video()} if served is None else served) as server:
        module = _edit_module(repo, sent, store=store)
        take = _plant_take(repo, server.url("base.mp4"), duration_ms=6000)
        job = await module.service.submit_video_edit(
            PRINCIPAL, _edit_in(take.id, start_ms=1000, end_ms=5000)
        )
        await module.queue.run_submit(str(job.id))

    edit = repo.jobs[job.id]
    assert (edit.status, edit.error_code) == (STATUS_FAILED, code)
    assert sent == [], "切段失败就不交给上游"


class _HeldStore(MemoryObjectStore):
    def __init__(self) -> None:
        super().__init__()
        self.release = asyncio.Event()
        self.holding = 0

    async def put_public_object(
        self,
        *,
        object_key: str,
        content: bytes,
        content_type: str,
        metadata: Mapping[str, str] | None = None,
    ) -> str:
        self.holding += 1
        await self.release.wait()
        return await super().put_public_object(
            object_key=object_key, content=content, content_type=content_type, metadata=metadata
        )


async def test_composites_and_edit_cuts_share_one_local_processing_limit() -> None:
    limit = 2
    repo = InMemoryGenerationRepository()
    store = _HeldStore()
    sent: list[dict[str, Any]] = []
    async with serving({"base.mp4": _base_video()}) as server:
        module = _edit_module(
            repo,
            sent,
            store=store,
            queue_settings=GenerationQueueSettings(compose_concurrency=limit),
        )
        take = _plant_take(repo, server.url("base.mp4"), duration_ms=6000)
        jobs = [
            await module.service.submit_video_edit(
                PRINCIPAL, _edit_in(take.id, start_ms=1000, end_ms=5000)
            )
            for _ in range(3)
        ]
        jobs += [
            await module.service.submit_video_compose(
                PRINCIPAL,
                VideoComposeIn(
                    base_job_id=take.id,
                    segments=[ComposeSegmentIn(source_job_id=take.id, start=0, end=1)],
                    user_name="tester",
                ),
            )
            for _ in range(3)
        ]
        runs = [asyncio.create_task(module.queue.run_submit(str(job.id))) for job in jobs]
        async with asyncio.timeout(60):
            while store.holding < limit:
                await asyncio.sleep(0.01)
        await asyncio.sleep(0.5)

        assert store.holding == limit, "卡在上传的加工占满上限，其余还在等"
        assert len(server.deliveries) == limit, "等着的加工连素材都还没取"
        store.release.set()
        await asyncio.gather(*runs)

    assert store.holding == len(jobs)
    assert len(server.deliveries) == len(jobs)
    assert {repo.jobs[job.id].status for job in jobs[:3]} == {STATUS_SUBMITTED}
    assert {repo.jobs[job.id].status for job in jobs[3:]} == {STATUS_COMPLETED}
    assert len(sent) == 3


async def test_an_image_clip_goes_through_the_same_queue_as_a_first_frame_request() -> None:
    repo = InMemoryGenerationRepository()
    take = make_job(
        video_request(),
        status=STATUS_COMPLETED,
        owner_user_id=PRINCIPAL.user_id,
        output=GenerationOutput(url="https://cdn.test/base.mp4", duration_ms=6000),
        shot_index=2,
    )
    repo.jobs[take.id] = take
    sent: list[dict[str, Any]] = []
    store = MemoryObjectStore()
    module = _edit_module(repo, sent, store=store)
    job = await module.service.submit_video_edit(
        PRINCIPAL,
        VideoEditIn(
            mode="image",
            source_job_id=take.id,
            range_start_ms=1000,
            range_end_ms=2000,
            model=MODEL,
            prompt="参考 @Image1，人物转身",
            user_name="tester",
            seconds=5,
            reference_image_urls=["https://cdn.test/outfit.png"],
        ),
    )
    await module.queue.run_submit(str(job.id))
    edit = repo.jobs[job.id]
    assert edit.status == STATUS_SUBMITTED, edit.error_message
    assert (edit.source_job_id, edit.root_job_id, edit.shot_index) == (take.id, take.id, 2)
    assert store.objects == {}, "图生不切参考片段"
    (body,) = sent
    assert body["reference_video_urls"] == []
    assert body["reference_image_urls"] == ["https://cdn.test/outfit.png"]
    assert body["seconds"] == 5
    assert "provider_options" not in body, "单图交给网关按首帧调度，不指定子任务"
    assert "aspect_ratio" not in body
