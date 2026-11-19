from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory

import httpx
import pytest
from procrastinate.testing import InMemoryConnector

from iclip.domains.generation.model_groups import ModelGroup, ModelGroups
from iclip.domains.generation.models import (
    STATUS_COMPLETED,
    STATUS_SUBMITTED,
    GenerationJob,
)
from iclip.domains.generation.module import (
    GenerationModule,
    ImageModelConfig,
    QwenServiceConfig,
    build_generation_module,
)
from iclip.domains.generation.music import MUSIC_MODEL
from iclip.domains.generation.qwen import QwenEndpoint
from iclip.domains.generation.schemas import MusicIn, SubtitleIn, VideoEditIn, VideoEnhanceIn
from iclip.domains.generation.service import VideoEnhanceSpec
from iclip.domains.generation.subtitles import SUBTITLE_MODEL
from iclip.domains.generation.video import VideoProviderSettings
from iclip.domains.identity.acting import ActAs
from iclip.domains.identity.models import Principal, UserAccount
from iclip.domains.identity.public import ModelGroupAssignments
from iclip.platform.media.codec import SOFTWARE
from iclip.platform.media.process import ffmpeg_available
from tests.helpers.fetch_url import as_is
from tests.helpers.generation import (
    MUSIC_PROMPT,
    FakeReferenceAssets,
    FixedLineage,
    InMemoryGenerationRepository,
    MemoryObjectStore,
    video_request,
)
from tests.helpers.identity import InMemoryUserRepository, make_account
from tests.helpers.media import synthesize_padded_music, synthesize_video

pytestmark = [
    pytest.mark.anyio,
    pytest.mark.skipif(not ffmpeg_available(), reason="本机 PATH 上没有 ffmpeg/ffprobe"),
]

MODEL = "vendor-a-seedance-2-5"
ENHANCE_MODEL = "video-enhance"

VIDEO_SUBMIT_URL = "https://video.test/generate"
VIDEO_STATUS_URL = "https://video.test/tasks"
ENHANCE_URL = "https://video.test/videos/enhance/async"
ASR_URL = "https://asr.test/generation"
MUSIC_URL = "https://music.test/SpeechSynthesizer"
TAKE_URL = "https://cdn.test/take.mp4"
GENERATED_MUSIC_URL = "https://result.test/generated.wav"

CONVERSATION = uuid.uuid4()

GROUPS = (
    ModelGroup(
        name="mkt",
        video_api_key="vk-mkt",
        video_models={MODEL: "mkt-seedance", ENHANCE_MODEL: "mkt-enhance"},
        subtitle_api_key="asr-mkt",
        music_api_key="music-mkt",
    ),
    ModelGroup(
        name="ecom",
        video_api_key="vk-ecom",
        video_models={MODEL: "ecom-seedance", ENHANCE_MODEL: "ecom-enhance"},
        subtitle_api_key="asr-ecom",
        music_api_key="music-ecom",
    ),
)


@dataclass(frozen=True)
class Sent:
    url: str
    key: str | None
    model: str | None


class Upstream:
    """视频网关、千问识别与音乐接口的替身，记下每次调用带的 key 与 model。"""

    def __init__(self, video: bytes, music: bytes) -> None:
        self.video = video
        self.music = music
        self.sent: list[Sent] = []

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self._handle)

    def _handle(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url == TAKE_URL:
            return httpx.Response(200, content=self.video)
        if url == GENERATED_MUSIC_URL:
            return httpx.Response(200, content=self.music)
        body = json.loads(request.content) if request.content else {}
        self.sent.append(
            Sent(
                url=url.split("?")[0],
                key=request.headers.get("X-API-Key") or request.headers.get("Authorization"),
                model=body.get("model"),
            )
        )
        if url in (VIDEO_SUBMIT_URL, ENHANCE_URL):
            return httpx.Response(200, json={"task_id": "t-1"})
        if url.startswith(VIDEO_STATUS_URL):
            return httpx.Response(
                200,
                json={
                    "status": "succeeded",
                    "result": {
                        "output_url": TAKE_URL,
                        "watermark_output_url": "https://cdn.test/take-wm.mp4",
                        "output_duration_seconds": 2,
                    },
                },
            )
        if url == ASR_URL:
            return httpx.Response(
                200,
                json={
                    "request_id": "asr-1",
                    "output": {"sentences": [{"begin_time": 0, "end_time": 900, "text": "你好"}]},
                },
            )
        if url == MUSIC_URL:
            return httpx.Response(
                200,
                json={"request_id": "music-1", "output": {"audio": {"url": GENERATED_MUSIC_URL}}},
            )
        return httpx.Response(404)


@pytest.fixture(scope="module")
def media() -> tuple[bytes, bytes]:
    with TemporaryDirectory(prefix="model-groups-fixture-") as tmp:
        video = synthesize_video(Path(tmp) / "take.mp4", size="160x120", seconds=2, audio=True)
        music = synthesize_padded_music(Path(tmp) / "music.wav", lead=0.5, body=2.0, tail=0.5)
    return video, music


async def _keep_completion(_conversation_id: uuid.UUID, _owner: uuid.UUID) -> None:
    return None


def _module(
    repo: InMemoryGenerationRepository, users: InMemoryUserRepository, upstream: Upstream
) -> GenerationModule:
    transport = upstream.transport()
    return build_generation_module(
        repo,
        act_as=ActAs(users),
        clear_completion=_keep_completion,
        lineage=FixedLineage(),
        references=FakeReferenceAssets(),
        video=VideoProviderSettings(
            submit_url=VIDEO_SUBMIT_URL,
            status_base_url=VIDEO_STATUS_URL,
            api_key="vk-default",
            enhance_submit_url=ENHANCE_URL,
        ),
        video_enhance=VideoEnhanceSpec(model=ENHANCE_MODEL, resolutions=("1080p",), fps=None),
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
        subtitles=QwenServiceConfig(
            endpoint=QwenEndpoint(url=ASR_URL, api_key="asr-default", timeout_seconds=30),
            concurrency=1,
        ),
        music=QwenServiceConfig(
            endpoint=QwenEndpoint(url=MUSIC_URL, api_key="music-default", timeout_seconds=30),
            concurrency=1,
        ),
        model_groups=ModelGroups(
            GROUPS,
            group_of=ModelGroupAssignments(users, [group.name for group in GROUPS]).group_of,
        ),
        video_transport=transport,
        subtitle_transport=transport,
        music_transport=transport,
    )


def _principal(account: UserAccount) -> Principal:
    return Principal(
        kind="user",
        user_id=account.id,
        permissions=frozenset({"generation:submit"}),
        audit_label=account.username or "",
        username=account.username,
    )


async def _make_everything(
    module: GenerationModule, principal: Principal
) -> tuple[GenerationJob, ...]:
    """出片、编辑片段、高清版、字幕、配乐各走一遍，每条都交给上游。"""
    user_name = principal.username
    take = await module.service.submit_video(
        principal,
        video_request(user_name=user_name, conversation_id=CONVERSATION, resolution="720p"),
    )
    await module.queue.run_submit(str(take.id))
    await module.queue.run_poll(str(take.id))
    edit = await module.service.submit_video_edit(
        principal,
        VideoEditIn(
            source_job_id=take.id,
            conversation_id=CONVERSATION,
            range_start_ms=0,
            range_end_ms=1000,
            reference_image_urls=["https://cdn.test/sandal.png"],
            model=MODEL,
            prompt="把凉鞋换成编织款",
            user_name=user_name,
            seconds=5,
        ),
    )
    await module.queue.run_submit(str(edit.id))
    enhance = await module.service.submit_video_enhance(
        principal, VideoEnhanceIn(source_job_id=take.id, resolution="1080p", user_name=user_name)
    )
    await module.queue.run_submit(str(enhance.id))
    subtitle = await module.service.submit_subtitle(
        principal, SubtitleIn(source_job_id=take.id, conversation_id=CONVERSATION)
    )
    await module.queue.run_submit(str(subtitle.id))
    music = await module.service.submit_music(
        principal, MusicIn(conversation_id=CONVERSATION, prompt=MUSIC_PROMPT)
    )
    await module.queue.run_submit(str(music.id))
    return take, edit, enhance, subtitle, music


@pytest.mark.parametrize(
    ("group", "video_key", "video_model", "enhance_model", "asr_key", "music_key"),
    [
        ("mkt", "vk-mkt", "mkt-seedance", "mkt-enhance", "asr-mkt", "music-mkt"),
        ("ecom", "vk-ecom", "ecom-seedance", "ecom-enhance", "asr-ecom", "music-ecom"),
        (None, "vk-default", MODEL, ENHANCE_MODEL, "asr-default", "music-default"),
    ],
    ids=["mkt", "ecom", "default_group"],
)
async def test_each_user_reaches_upstream_with_their_groups_key_and_model_id(
    media: tuple[bytes, bytes],
    group: str | None,
    video_key: str,
    video_model: str,
    enhance_model: str,
    asr_key: str,
    music_key: str,
) -> None:
    account = make_account(model_group=group)
    users = InMemoryUserRepository([account])
    repo = InMemoryGenerationRepository()
    upstream = Upstream(*media)
    module = _module(repo, users, upstream)

    jobs = await _make_everything(module, _principal(account))

    take, edit, enhance, subtitle, music = (repo.jobs[job.id] for job in jobs)
    assert [job.status for job in (take, edit, enhance, subtitle, music)] == [
        STATUS_COMPLETED,
        STATUS_SUBMITTED,
        STATUS_SUBMITTED,
        STATUS_COMPLETED,
        STATUS_COMPLETED,
    ], [job.error_message for job in (take, edit, enhance, subtitle, music)]
    assert upstream.sent == [
        Sent(VIDEO_SUBMIT_URL, video_key, video_model),
        Sent(f"{VIDEO_STATUS_URL}/t-1", video_key, None),
        Sent(VIDEO_SUBMIT_URL, video_key, video_model),
        Sent(ENHANCE_URL, video_key, enhance_model),
        Sent(ASR_URL, f"Bearer {asr_key}", SUBTITLE_MODEL),
        Sent(MUSIC_URL, f"Bearer {music_key}", MUSIC_MODEL),
    ]
    upstream_model = None if group is None else video_model
    upstream_enhance = None if group is None else enhance_model
    assert [(job.model_group, job.upstream_model) for job in (take, edit, enhance)] == [
        (group, upstream_model),
        (group, upstream_model),
        (group, upstream_enhance),
    ]
    assert [(job.model_group, job.upstream_model) for job in (subtitle, music)] == [
        (group, None),
        (group, None),
    ]
