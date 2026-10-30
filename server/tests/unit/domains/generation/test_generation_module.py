"""装配层的图片模型注册表：能力声明与适配器出自同一张表，按同一个名字对上。"""

from __future__ import annotations

import json
import uuid
from collections.abc import Sequence
from dataclasses import replace

import httpx
import pytest
from procrastinate.testing import InMemoryConnector

from iclip.domains.generation.models import STATUS_COMPLETED, GenerationOutput
from iclip.domains.generation.module import (
    IMAGE_MODEL_SPECS,
    GenerationModule,
    ImageModelConfig,
    build_generation_module,
)
from iclip.domains.generation.schemas import VideoEnhanceIn
from iclip.domains.generation.service import VideoEnhanceSpec
from iclip.domains.generation.video import VideoProviderSettings
from iclip.domains.identity.acting import ActAs
from iclip.domains.identity.models import Principal
from iclip.platform.media.codec import SOFTWARE
from tests.helpers.fetch_url import as_is
from tests.helpers.generation import (
    FixedLineage,
    InMemoryGenerationRepository,
    MemoryObjectStore,
    image_request,
    make_job,
    video_request,
)
from tests.helpers.identity import InMemoryUserRepository

GATEWAY = "https://image.test"

COMMON_KEYS = {"data_id", "user_name", "prompt", "task_source", "env"}
"""各家 payload 共有的键，由网关 provider 统一填。"""

OWN_KEYS = {
    "nano_banana_pro": {"aspect_ratio", "resolution", "channel"},
    "seedream_v5_pro": {"size", "output_format"},
    "gpt-image-2.5": {"size", "quality"},
}
"""各家专有的键。表的键也钉住了落库的 provider 名：改名等于丢掉历史对账。"""

PRINCIPAL = Principal(
    kind="user",
    user_id=uuid.uuid4(),
    permissions=frozenset({"generation:submit"}),
    audit_label="tester",
    username="tester",
)


async def _keep_completion(_conversation_id: uuid.UUID, _owner: uuid.UUID) -> None:
    return None


VIDEO = VideoProviderSettings(
    submit_url="https://video.test/generate",
    status_base_url="https://video.test/tasks",
    api_key="secret-key",
)


def build(
    repo: InMemoryGenerationRepository,
    *,
    names: Sequence[str],
    transport: httpx.AsyncBaseTransport | None = None,
    video: VideoProviderSettings = VIDEO,
    video_enhance: VideoEnhanceSpec | None = None,
    video_transport: httpx.AsyncBaseTransport | None = None,
) -> GenerationModule:
    return build_generation_module(
        repo,
        act_as=ActAs(InMemoryUserRepository()),
        clear_completion=_keep_completion,
        lineage=FixedLineage(),
        video=video,
        video_enhance=video_enhance,
        video_transport=video_transport,
        video_default_model="vendor-a-seedance-2-5",
        video_allowed_models=("vendor-a-seedance-2-5",),
        image_models=[
            ImageModelConfig(name=name, api_base=f"{GATEWAY}/{name}", concurrency=1)
            for name in names
        ],
        image_default_model=names[0],
        image_env="test",
        image_text_to_image_task="text-to-image",
        image_edit_task="image-edit",
        object_store=MemoryObjectStore(),
        queue_connector=InMemoryConnector(),
        media_codec=SOFTWARE,
        fetch_url=as_is,
        image_transport=transport,
    )


async def test_every_registered_image_model_is_wired_to_its_own_payload() -> None:
    """按名字受理的那家，排进队列后打的是它自己的地址、发的是它自己的键。"""

    sent: dict[str, dict[str, object]] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            sent[request.url.path.split("/")[1]] = json.loads(request.content)
            return httpx.Response(200, json={"success": True, "output_str": f"{GATEWAY}/o.png"})
        return httpx.Response(200, content=b"PNG", headers={"content-type": "image/png"})

    repo = InMemoryGenerationRepository()
    module = build(repo, names=list(IMAGE_MODEL_SPECS), transport=httpx.MockTransport(handler))

    _, declared = module.service.image_models()
    assert dict(declared) == IMAGE_MODEL_SPECS, "受理层与能力清单端点照的就是这张表"
    for name, spec in IMAGE_MODEL_SPECS.items():
        job = await module.service.submit_image(
            PRINCIPAL,
            image_request(
                model=name, aspect_ratio=spec.aspect_ratios[0], resolution=spec.resolutions[0]
            ),
        )
        assert job.provider == name
        await module.queue.run_submit(str(job.id))
        assert repo.jobs[job.id].status == STATUS_COMPLETED

    assert {name: set(payload) - COMMON_KEYS for name, payload in sent.items()} == OWN_KEYS
    assert all(set(payload) >= COMMON_KEYS for payload in sent.values())


async def test_a_model_can_declare_its_own_task_routes() -> None:
    """一家模型在网关上的两条路由与别家不同名时，照它自己声明的打。"""

    hit: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            hit.append(str(request.url))
            return httpx.Response(200, json={"success": True, "output_str": f"{GATEWAY}/o.png"})
        return httpx.Response(200, content=b"PNG", headers={"content-type": "image/png"})

    repo = InMemoryGenerationRepository()
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
        video_default_model="vendor-a-seedance-2-5",
        video_allowed_models=("vendor-a-seedance-2-5",),
        image_models=[
            ImageModelConfig(name="nano_banana_pro", api_base=f"{GATEWAY}/nano", concurrency=1),
            ImageModelConfig(
                name="gpt-image-2.5",
                api_base=f"{GATEWAY}/openai/gpt-image",
                concurrency=1,
                text_to_image_task="text-to-image",
                image_edit_task="edit",
            ),
        ],
        image_default_model="nano_banana_pro",
        image_env="test",
        image_text_to_image_task="text-to-image_shared",
        image_edit_task="image-edit_shared",
        object_store=MemoryObjectStore(),
        queue_connector=InMemoryConnector(),
        media_codec=SOFTWARE,
        fetch_url=as_is,
        image_transport=httpx.MockTransport(handler),
    )

    for model, references in (
        ("gpt-image-2.5", []),
        ("gpt-image-2.5", [f"{GATEWAY}/ref.png"]),
        ("nano_banana_pro", []),
    ):
        spec = IMAGE_MODEL_SPECS[model]
        job = await module.service.submit_image(
            PRINCIPAL,
            image_request(
                model=model,
                aspect_ratio=spec.aspect_ratios[0],
                resolution=spec.resolutions[0],
                reference_image_urls=references,
            ),
        )
        await module.queue.run_submit(str(job.id))

    assert hit == [
        f"{GATEWAY}/openai/gpt-image/text-to-image",
        f"{GATEWAY}/openai/gpt-image/edit",
        f"{GATEWAY}/nano/text-to-image_shared",
    ]


def test_an_image_model_without_an_adapter_fails_at_assembly() -> None:
    with pytest.raises(RuntimeError, match="没有 flux 这家图片模型的适配器"):
        build(InMemoryGenerationRepository(), names=["flux"])


ENHANCE_URL = "https://video.test/videos/enhance/async"
ENHANCE = VideoEnhanceSpec(model="video-enhance", resolutions=("1080p", "720p"), fps=30)


async def test_an_enhancement_runs_through_the_video_lane_to_both_addresses() -> None:
    """装配好的超分：受理后排进视频那条队列，提交打超分地址，查询与结果同出片。"""

    calls: list[tuple[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append((request.method, str(request.url)))
        if request.method == "POST":
            return httpx.Response(200, json={"task_id": "e-1"})
        return httpx.Response(
            200,
            json={
                "status": "succeeded",
                "result": {
                    "output_url": "https://cdn.test/hd.mp4",
                    "watermark_output_url": "https://cdn.test/hd-wm.mp4",
                },
            },
        )

    take = make_job(
        video_request(resolution="720p"),
        status=STATUS_COMPLETED,
        output=GenerationOutput(
            url="https://cdn.test/take.mp4", watermark_url="https://cdn.test/take-wm.mp4"
        ),
    )
    repo = InMemoryGenerationRepository([take])
    module = build(
        repo,
        names=["nano_banana_pro"],
        video=replace(VIDEO, enhance_submit_url=ENHANCE_URL),
        video_enhance=ENHANCE,
        video_transport=httpx.MockTransport(handler),
    )

    job = await module.service.submit_video_enhance(
        PRINCIPAL, VideoEnhanceIn(source_job_id=take.id, resolution="1080p", user_name="tester")
    )
    await module.queue.run_submit(str(job.id))
    await module.queue.run_poll(str(job.id))

    done = repo.jobs[job.id]
    assert (done.status, done.output.url, done.output.watermark_url) == (
        STATUS_COMPLETED,
        "https://cdn.test/hd.mp4",
        "https://cdn.test/hd-wm.mp4",
    )
    assert calls == [
        ("POST", ENHANCE_URL),
        ("GET", "https://video.test/tasks/e-1?user_name=tester"),
    ]


@pytest.mark.parametrize(
    ("video", "video_enhance"),
    [(replace(VIDEO, enhance_submit_url=ENHANCE_URL), None), (VIDEO, ENHANCE)],
    ids=["address_only", "spec_only"],
)
def test_half_wired_enhance_fails_at_assembly(
    video: VideoProviderSettings, video_enhance: VideoEnhanceSpec | None
) -> None:
    with pytest.raises(RuntimeError, match="高清版"):
        build(
            InMemoryGenerationRepository(),
            names=["nano_banana_pro"],
            video=video,
            video_enhance=video_enhance,
        )
