from __future__ import annotations

import uuid
from dataclasses import replace

import httpx
import pytest
from procrastinate.testing import InMemoryConnector

from iclip.domains.generation.dubbing import PROVIDER_NAME as DUBBING_PROVIDER
from iclip.domains.generation.model_groups import ModelGroup, ModelGroups
from iclip.domains.generation.models import (
    STATUS_COMPLETED,
    STATUS_FAILED,
    GenerationJob,
    GenerationOutput,
)
from iclip.domains.generation.module import (
    DubbingSetup,
    GenerationModule,
    ImageModelConfig,
    QwenServiceConfig,
    build_generation_module,
)
from iclip.domains.generation.music import PROVIDER_NAME as MUSIC_PROVIDER
from iclip.domains.generation.qwen import QwenEndpoint
from iclip.domains.generation.schemas import DubbingLine
from iclip.domains.generation.speech import QwenSpeechSynthesizer
from iclip.domains.generation.subtitles import PROVIDER_NAME as SUBTITLE_PROVIDER
from iclip.domains.generation.video import PROVIDER_NAME as VIDEO_PROVIDER
from iclip.domains.generation.video import VideoProviderSettings
from iclip.domains.identity.acting import ActAs
from iclip.platform.media.codec import SOFTWARE
from tests.helpers.fetch_url import as_is
from tests.helpers.generation import (
    FakeReferenceAssets,
    FixedLineage,
    InMemoryGenerationRepository,
    MemoryObjectStore,
    make_dubbing,
    make_job,
    make_music,
    make_subtitle,
    video_request,
)
from tests.helpers.identity import InMemoryUserRepository

MODEL = "vendor-a-seedance-2-5"

MKT = ModelGroup(name="mkt", video_api_key="vk-mkt", video_models={MODEL: "mkt-seedance"})


async def _nobody_is_grouped(_user_id: uuid.UUID) -> str | None:
    return None


async def _keep_completion(_conversation_id: uuid.UUID, _owner: uuid.UUID) -> None:
    return None


def _module(repo: InMemoryGenerationRepository, sent: list[httpx.Request]) -> GenerationModule:
    def upstream(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        return httpx.Response(200, json={"task_id": "t-1"})

    transport = httpx.MockTransport(upstream)
    qwen = QwenServiceConfig(
        endpoint=QwenEndpoint(url="https://qwen.test", api_key="sk-default", timeout_seconds=30),
        concurrency=1,
    )
    return build_generation_module(
        repo,
        act_as=ActAs(InMemoryUserRepository()),
        clear_completion=_keep_completion,
        lineage=FixedLineage(),
        references=FakeReferenceAssets(),
        video=VideoProviderSettings(
            submit_url="https://video.test/generate",
            status_base_url="https://video.test/tasks",
            api_key="vk-default",
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
        media_codec=SOFTWARE,
        fetch_url=as_is,
        subtitles=qwen,
        music=qwen,
        dubbing=DubbingSetup(
            synthesizer=QwenSpeechSynthesizer(qwen.endpoint, transport=transport),
            concurrency=1,
        ),
        model_groups=ModelGroups((MKT,), group_of=_nobody_is_grouped),
        video_transport=transport,
        subtitle_transport=transport,
        music_transport=transport,
    )


def _take() -> GenerationJob:
    return make_job(video_request(), provider=VIDEO_PROVIDER)


def _completed_take() -> GenerationJob:
    return replace(
        _take(), status=STATUS_COMPLETED, output=GenerationOutput(url="https://cdn.test/take.mp4")
    )


def _subtitle() -> GenerationJob:
    return replace(make_subtitle(_completed_take()), provider=SUBTITLE_PROVIDER)


def _dubbing() -> GenerationJob:
    lines = [DubbingLine(start_ms=0, end_ms=4_000, text="Hello")]
    return replace(
        make_dubbing(_completed_take(), lines, duration_ms=5_000), provider=DUBBING_PROVIDER
    )


@pytest.mark.parametrize(
    ("job", "code", "names"),
    [
        (replace(_take(), model_group="mkt"), "MODEL_GROUP_UPSTREAM_MODEL_MISSING", "mkt"),
        (
            replace(_take(), model_group="retired", upstream_model="old-seedance"),
            "MODEL_GROUP_UNKNOWN",
            "retired",
        ),
        (replace(_subtitle(), model_group="mkt"), "MODEL_GROUP_KEY_MISSING", "mkt"),
        (
            replace(make_music(), provider=MUSIC_PROVIDER, model_group="mkt"),
            "MODEL_GROUP_KEY_MISSING",
            "mkt",
        ),
        (replace(_dubbing(), model_group="mkt"), "MODEL_GROUP_KEY_MISSING", "mkt"),
        (replace(_dubbing(), model_group="retired"), "MODEL_GROUP_UNKNOWN", "retired"),
    ],
    ids=[
        "no_upstream_model",
        "group_gone",
        "no_subtitle_key",
        "no_music_key",
        "no_dubbing_key",
        "dubbing_group_gone",
    ],
)
async def test_a_grouped_record_that_cannot_be_served_fails_without_calling_upstream(
    job: GenerationJob, code: str, names: str
) -> None:
    repo = InMemoryGenerationRepository([job])
    sent: list[httpx.Request] = []

    await _module(repo, sent).queue.run_submit(str(job.id))

    failed = repo.jobs[job.id]
    assert (failed.status, failed.error_code) == (STATUS_FAILED, code)
    assert failed.error_message is not None and names in failed.error_message
    assert sent == [], "缺什么都不拿别的 key 或原模型名兜底"
