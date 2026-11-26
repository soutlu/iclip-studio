from __future__ import annotations

import json
import subprocess
import uuid
from collections.abc import Mapping
from dataclasses import replace
from datetime import UTC, datetime
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

import httpx
import pytest
from PIL import Image, ImageStat
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
from iclip.domains.generation.schemas import (
    ComposeSegmentIn,
    TransitionMode,
    VideoComposeIn,
    VideoTransitionIn,
    VideoTransitionRequest,
)
from iclip.domains.generation.video import VideoProviderSettings
from iclip.domains.identity.acting import ActAs
from iclip.domains.identity.models import Principal
from iclip.platform.media.codec import SOFTWARE
from iclip.platform.media.probe import VideoProfile, probe_video
from iclip.platform.media.process import ffmpeg_available
from iclip.platform.object_store.layout import MEDIA_PATHS
from iclip.platform.object_store.store import ObjectStoreUnavailable
from tests.helpers.fetch_url import as_is
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

# 第 N 帧的亮度为 16 + N × 6（有限范围），抽成全范围 JPEG 后约为 N × 6 × 255 / 219。
_LUMA_STEP = 6 * 255 / 219

PRINCIPAL = Principal(
    kind="user",
    user_id=uuid.uuid4(),
    permissions=frozenset({"generation:submit"}),
    audit_label="tester",
    username="tester",
)


async def _keep_completion(_conversation_id: uuid.UUID, _owner: uuid.UUID) -> None:
    return None


def _module(
    repo: InMemoryGenerationRepository, sent: list[dict[str, Any]], *, store: MemoryObjectStore
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
        fetch_url=as_is,
        model_groups=default_only((MODEL,)),
        video_transport=httpx.MockTransport(upstream),
    )


def _numbered_frames(seconds: int) -> bytes:
    """每帧亮度不同的无损视频，10 fps，64x64。"""

    with TemporaryDirectory(prefix="transition-fixture-") as tmp:
        path = Path(tmp) / "numbered.mp4"
        subprocess.run(
            [
                "ffmpeg", "-v", "error", "-y", "-f", "lavfi",
                "-i", f"color=c=black:s=64x64:r=10:d={seconds},format=yuv420p,"
                "geq=lum='16+N*6':cb=128:cr=128",
                "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p", str(path),
            ],
            check=True,
            capture_output=True,
        )  # fmt: skip
        return path.read_bytes()


def _plain_video(*, size: str, audio: bool) -> bytes:
    with TemporaryDirectory(prefix="transition-fixture-") as tmp:
        return synthesize_video(Path(tmp) / "plain.mp4", size=size, seconds=6, audio=audio)


def _frame_index(jpeg: bytes) -> float:
    with Image.open(BytesIO(jpeg)) as image:
        return ImageStat.Stat(image.convert("L")).mean[0] / _LUMA_STEP


async def _profile_of(content: bytes) -> VideoProfile:
    with TemporaryDirectory(prefix="transition-probe-") as tmp:
        path = Path(tmp) / "out.mp4"
        path.write_bytes(content)
        return await probe_video(path)


def _plant_take(
    repo: InMemoryGenerationRepository, url: str, *, duration_ms: int | None = None
) -> GenerationJob:
    take = make_job(
        video_request(resolution="720p"),
        status=STATUS_COMPLETED,
        owner_user_id=PRINCIPAL.user_id,
        output=GenerationOutput(url=url, duration_ms=duration_ms),
        finished_at=datetime.now(UTC),
    )
    repo.jobs[take.id] = take
    return take


def _transition_in(
    left: GenerationJob,
    right: GenerationJob,
    *,
    mode: TransitionMode,
    left_end_ms: int,
    right_start_ms: int,
    **fields: Any,
) -> VideoTransitionIn:
    return VideoTransitionIn(
        left_job_id=left.id,
        left_end_ms=left_end_ms,
        right_job_id=right.id,
        right_start_ms=right_start_ms,
        mode=mode,
        model=MODEL,
        prompt="人物从门口走到窗边",
        user_name="tester",
        seconds=5 if mode == "first_last_frame" else None,
        **fields,
    )


@pytest.mark.parametrize(
    ("left_end_ms", "right_start_ms", "left_frame", "right_frame"),
    [(1500, 1500, 14, 15), (1550, 1550, 15, 16), (3040, 0, 29, 0)],
    ids=["接点在帧上", "接点在两帧之间", "A 的接点越过结尾取最后一帧"],
)
async def test_first_last_frames_are_cut_where_the_composite_will_join(
    left_end_ms: int, right_start_ms: int, left_frame: int, right_frame: int
) -> None:
    repo = InMemoryGenerationRepository()
    store = MemoryObjectStore()
    sent: list[dict[str, Any]] = []
    async with serving({"a.mp4": _numbered_frames(3), "b.mp4": _numbered_frames(3)}) as server:
        module = _module(repo, sent, store=store)
        left = _plant_take(repo, server.url("a.mp4"))
        right = _plant_take(repo, server.url("b.mp4"))
        job = await module.service.submit_video_transition(
            PRINCIPAL,
            _transition_in(
                left,
                right,
                mode="first_last_frame",
                left_end_ms=left_end_ms,
                right_start_ms=right_start_ms,
            ),
        )
        first_key = MEDIA_PATHS.transition_first_frame(job_id=job.id)
        last_key = MEDIA_PATHS.transition_last_frame(job_id=job.id)
        frame_urls = [store.public_url(first_key), store.public_url(last_key)]
        request = stored_request(job)
        assert isinstance(request, VideoTransitionRequest)
        assert request.reference_image_urls == frame_urls, "受理时就定好首尾帧地址"
        assert store.objects == {}, "受理时不抽帧"

        await module.queue.run_submit(str(job.id))

    transition = repo.jobs[job.id]
    assert transition.status == STATUS_SUBMITTED, transition.error_message
    (first, first_type), (last, last_type) = store.objects[first_key], store.objects[last_key]
    assert (first_type, last_type) == ("image/jpeg", "image/jpeg")
    assert _frame_index(first) == pytest.approx(left_frame, abs=0.3), "A 在接点之前的最后一帧"
    assert _frame_index(last) == pytest.approx(right_frame, abs=0.3), "B 在接点处的那一帧"
    (body,) = sent
    assert body["reference_image_urls"] == frame_urls, "上游拿到的就是抽好的两帧"
    assert body["reference_video_urls"] == []
    assert (body["seconds"], body["prompt"], body["resolution"]) == (
        5,
        "人物从门口走到窗边",
        "720p",
    ), "分辨率没传时沿用 A 的原片"
    assert {"aspect_ratio", "generate_audio", "provider_options"}.isdisjoint(body)
    assert {"mode", "left_job_id", "left_end_ms", "right_job_id", "right_start_ms"}.isdisjoint(
        body
    ), "衔接方式与接点不发上游"


async def test_output_settings_given_by_the_caller_reach_the_upstream() -> None:
    repo = InMemoryGenerationRepository()
    store = MemoryObjectStore()
    sent: list[dict[str, Any]] = []
    async with serving({"a.mp4": _numbered_frames(3), "b.mp4": _numbered_frames(3)}) as server:
        module = _module(repo, sent, store=store)
        left = _plant_take(repo, server.url("a.mp4"))
        right = _plant_take(repo, server.url("b.mp4"))
        job = await module.service.submit_video_transition(
            PRINCIPAL,
            _transition_in(
                left,
                right,
                mode="first_last_frame",
                left_end_ms=2000,
                right_start_ms=1000,
                resolution="1080p",
                aspect_ratio="adaptive",
                generate_audio=True,
            ),
        )
        await module.queue.run_submit(str(job.id))

    assert repo.jobs[job.id].status == STATUS_SUBMITTED, repo.jobs[job.id].error_message
    (body,) = sent
    assert (body["resolution"], body["aspect_ratio"], body["generate_audio"]) == (
        "1080p",
        "adaptive",
        True,
    )


async def test_a_video_edit_reference_joins_the_tail_of_a_and_the_head_of_b_in_as_format() -> None:
    repo = InMemoryGenerationRepository()
    store = MemoryObjectStore()
    sent: list[dict[str, Any]] = []
    served = {
        "a.mp4": _plain_video(size="320x240", audio=True),
        "b.mp4": _plain_video(size="640x360", audio=False),
    }
    async with serving(served) as server:
        module = _module(repo, sent, store=store)
        left = _plant_take(repo, server.url("a.mp4"))
        right = _plant_take(repo, server.url("b.mp4"))
        job = await module.service.submit_video_transition(
            PRINCIPAL,
            _transition_in(left, right, mode="video_edit", left_end_ms=4000, right_start_ms=2500),
        )
        clip_key = MEDIA_PATHS.transition_clip(job_id=job.id)
        clip_url = store.public_url(clip_key)
        request = stored_request(job)
        assert isinstance(request, VideoTransitionRequest)
        assert request.reference_video_urls == [clip_url], "受理时就定好参考片段地址"

        await module.queue.run_submit(str(job.id))
        transition = repo.jobs[job.id]
        assert transition.status == STATUS_SUBMITTED, transition.error_message
        content, content_type = store.objects[clip_key]
        assert content_type == "video/mp4"
        assert abs(await duration_ms_of(content) - 4500) <= FRAME_MS, "A 剩下 2 秒加 B 开头 2.5 秒"
        profile = await _profile_of(content)
        assert (profile.width, profile.height) == (320, 240), "规格以 A 为准"
        (body,) = sent
        assert body["reference_video_urls"] == [clip_url], "上游拿到的就是拼好的片段"
        assert (body["seconds"], body["provider_options"]) == (
            -1,
            {"omni_reference_task_type": "edit"},
        )

        repo.jobs[job.id] = replace(
            transition,
            status=STATUS_COMPLETED,
            output=GenerationOutput(url=server.url("t.mp4"), duration_ms=5000),
            finished_at=datetime.now(UTC),
        )
        composite = await module.service.submit_video_compose(
            PRINCIPAL,
            VideoComposeIn(
                base_job_id=left.id,
                segments=[
                    ComposeSegmentIn(source_job_id=left.id, start=0, end=4),
                    ComposeSegmentIn(source_job_id=job.id, start=0),
                    ComposeSegmentIn(source_job_id=right.id, start=2.5),
                ],
                user_name="tester",
            ),
        )

    assert (composite.operation, composite.source_job_id) == ("compose", left.id), (
        "衔接段完成后可以直接当合成的片段"
    )


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


@pytest.mark.parametrize("mode", ["first_last_frame", "video_edit"])
@pytest.mark.parametrize(
    ("served", "store", "code"),
    [
        ({}, MemoryObjectStore(), "MEDIA_SOURCE_UNREACHABLE"),
        (
            {"a.mp4": b"not a video", "b.mp4": b"not a video"},
            MemoryObjectStore(),
            "MEDIA_PROCESS_FAILED",
        ),
        (None, _UnavailableStore(), "OUTPUT_STORE_FAILED"),
    ],
    ids=["取不到素材片", "素材片加工不了", "存不进桶"],
)
async def test_a_failed_preparation_fails_the_transition_without_going_upstream(
    mode: TransitionMode, served: dict[str, bytes] | None, store: MemoryObjectStore, code: str
) -> None:
    repo = InMemoryGenerationRepository()
    sent: list[dict[str, Any]] = []
    fixtures = {"a.mp4": _numbered_frames(6), "b.mp4": _numbered_frames(6)}
    async with serving(fixtures if served is None else served) as server:
        module = _module(repo, sent, store=store)
        left = _plant_take(repo, server.url("a.mp4"), duration_ms=6000)
        right = _plant_take(repo, server.url("b.mp4"), duration_ms=6000)
        job = await module.service.submit_video_transition(
            PRINCIPAL,
            _transition_in(left, right, mode=mode, left_end_ms=3000, right_start_ms=2000),
        )
        await module.queue.run_submit(str(job.id))

    transition = repo.jobs[job.id]
    assert (transition.status, transition.error_code) == (STATUS_FAILED, code)
    assert sent == [], "准备失败就不交给上游"
