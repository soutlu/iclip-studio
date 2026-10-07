"""编辑段从受理到交上游走一遍装配好的模块：受理时探基底与参考片段的时长，入队后原样交给上游。

基底与片段放在本地 HTTP 服务上，由真 ffprobe 去探；上游是计数的 MockTransport，断言付费接口调没调。"""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

import httpx
import pytest
from procrastinate.testing import InMemoryConnector

from iclip.common.errors import ValidationFailed
from iclip.domains.generation.models import STATUS_COMPLETED, STATUS_SUBMITTED, GenerationJob
from iclip.domains.generation.module import ImageModelConfig, build_generation_module
from iclip.domains.generation.schemas import KIND_VIDEO, VideoEditIn, generation_out
from iclip.domains.generation.video import VideoProviderSettings
from iclip.domains.identity.acting import ActAs
from iclip.domains.identity.models import Principal
from iclip.platform.media.ffmpeg import ffmpeg_available
from tests.helpers.generation import (
    FixedLineage,
    InMemoryGenerationRepository,
    MemoryObjectStore,
    make_job,
    make_upload,
    stored_request,
    video_request,
)
from tests.helpers.identity import InMemoryUserRepository
from tests.helpers.media import synthesize_video
from tests.helpers.media_server import serving

pytestmark = [
    pytest.mark.anyio,
    pytest.mark.skipif(not ffmpeg_available(), reason="本机 PATH 上没有 ffmpeg/ffprobe"),
]

MODEL = "vendor-a-seedance-2-5"

PRINCIPAL = Principal(
    kind="user",
    user_id=uuid.uuid4(),
    permissions=frozenset({"generation:submit"}),
    audit_label="tester",
    username="tester",
)


async def _keep_completion(_conversation_id: uuid.UUID, _owner: uuid.UUID) -> None:
    return None


async def _run_edit(
    repo: InMemoryGenerationRepository, *, clip_seconds: int, start_ms: int, end_ms: int
) -> tuple[GenerationJob, list[dict[str, Any]], str]:
    """4 秒的出片作基底（没量过时长，受理时去探），本人上传一条 ``clip_seconds`` 秒的片段，
    受理一次编辑段并跑提交；返回落库的编辑段、上游收到的请求与片段地址。受理不通过就抛出。"""

    sent: list[dict[str, Any]] = []

    def upstream(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        return httpx.Response(200, json={"task_id": "upstream-1"})

    module = build_generation_module(
        repo,
        act_as=ActAs(InMemoryUserRepository()),
        clear_completion=_keep_completion,
        lineage=FixedLineage(),
        video=VideoProviderSettings(
            submit_url="https://video.test/generate",
            status_base_url="https://video.test/tasks",
            api_key="secret-key",
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
        object_store=MemoryObjectStore(),
        queue_connector=InMemoryConnector(),
        video_transport=httpx.MockTransport(upstream),
    )
    with TemporaryDirectory(prefix="edit-fixture-") as tmp:
        base = synthesize_video(Path(tmp) / "base.mp4", size="320x240", seconds=4, audio=True)
        clip = synthesize_video(
            Path(tmp) / "clip.mp4", size="320x240", seconds=clip_seconds, audio=True
        )
    async with serving({"base.mp4": base, "clip.mp4": clip}) as server:
        take = make_job(
            video_request(),
            status=STATUS_COMPLETED,
            owner_user_id=PRINCIPAL.user_id,
            output_url=server.url("base.mp4"),
        )
        upload = make_upload(
            kind=KIND_VIDEO, owner_user_id=PRINCIPAL.user_id, output_url=server.url("clip.mp4")
        )
        repo.jobs.update({take.id: take, upload.id: upload})
        job = await module.service.submit_video_edit(
            PRINCIPAL,
            VideoEditIn(
                source_job_id=take.id,
                range_start_ms=start_ms,
                range_end_ms=end_ms,
                reference_video_urls=[server.url("clip.mp4")],
                model=MODEL,
                prompt="换一双鞋",
                user_name="tester",
                seconds=-1,
            ),
        )
        await module.queue.run_submit(str(job.id))
        clip_url = server.url("clip.mp4")
    return repo.jobs[job.id], sent, clip_url


async def test_an_edit_goes_upstream_as_is_with_its_clip_recorded() -> None:
    edit, sent, clip_url = await _run_edit(
        InMemoryGenerationRepository(), clip_seconds=2, start_ms=1000, end_ms=3000
    )

    assert edit.status == STATUS_SUBMITTED, edit.error_message
    (body,) = sent
    assert body["reference_video_urls"] == [clip_url], "片段地址原样交给上游"
    assert (body["seconds"], body["user_name"], body["prompt"]) == (-1, "tester", "换一双鞋")
    assert (edit.range_start_ms, edit.range_end_ms) == (1000, 3000), "区间原样记，不改写"
    assert stored_request(edit).model_dump()["reference_video_urls"] == [clip_url]
    assert generation_out(edit, source_address=None).clip_stage is None, "编辑段没有本地加工"


async def test_a_clip_that_does_not_match_the_range_is_refused_before_anything_is_queued() -> None:
    repo = InMemoryGenerationRepository()

    with pytest.raises(ValidationFailed, match="对不上"):
        await _run_edit(repo, clip_seconds=3, start_ms=1000, end_ms=2000)

    assert len(repo.jobs) == 2, "只有种进去的基底与上传，没有编辑段落库"
