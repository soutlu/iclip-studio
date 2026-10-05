"""验证视频拆解工具：按时长选路、请求形状、响应校验，以及工作区与共用结果的复用。"""

from __future__ import annotations

import inspect
import json
import uuid
from typing import Any

import httpx
import pytest
from pydantic_ai import ModelRetry, ToolFailed
from pydantic_ai.models.test import TestModel
from pydantic_ai.tools import RunContext
from pydantic_ai.usage import RunUsage

from iclip.capabilities.iclip_studio.breakdown.model import ArkBreakdownModel
from iclip.capabilities.iclip_studio.breakdown.prompt import SYSTEM_PROMPT, USER_MESSAGE
from iclip.capabilities.iclip_studio.breakdown.service import VideoBreakdown
from iclip.capabilities.iclip_studio.capability import (
    IclipStudio,
    IclipStudioToolset,
    breakdown_doc_path,
)
from iclip.capabilities.iclip_studio.ports import SampledVideo
from iclip.capabilities.workspace.scope import workspace_namespace
from iclip.domains.agents.public import AgentRunDeps
from iclip.domains.identity.models import Principal
from iclip.platform.file_store.store import FileSpace
from iclip.platform.media.ffmpeg import MediaError
from iclip.platform.transcript.display import GenericDisplay
from tests.helpers.file_store import FakeFileStore

USER = uuid.UUID("11111111-1111-1111-1111-111111111111")
VIDEO = "https://cdn.test/ref.mp4"
NAMESPACE = f"{USER}/thread-1"
DOCUMENT = "# 出场元素\n……\n# 时间线\n……\n# 整片分析\n……"
PATH = breakdown_doc_path(VIDEO)
DONE = f"视频拆解完毕，文档在 {PATH}。"


class FakeSampler:
    """按给定时长作答，交出两帧；记下被要求抽帧的地址。"""

    def __init__(self, *, seconds: float, audio: bytes | None = b"mp3") -> None:
        self.seconds = seconds
        self.audio = audio
        self.sampled: list[str] = []
        self.error: MediaError | None = None

    async def duration_seconds(self, video_url: str) -> float:
        if self.error is not None:
            raise self.error
        return self.seconds

    async def sample(self, video_url: str) -> SampledVideo:
        self.sampled.append(video_url)
        return SampledVideo(frames=(b"frame-0", b"frame-1"), audio=self.audio)


class FakeShared:
    """共用结果的内存替身。"""

    def __init__(self) -> None:
        self.documents: dict[str, str] = {}
        self.asked: list[str] = []
        self.stored: list[str] = []

    async def get(self, video_url: str) -> str | None:
        self.asked.append(video_url)
        return self.documents.get(video_url)

    async def put(self, video_url: str, document: str) -> None:
        self.stored.append(video_url)
        self.documents[video_url] = document


class Upstream:
    """方舟接口的替身：记下收到的请求体，按设定的响应作答。"""

    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self.response = httpx.Response(200, json=responses_body())

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(json.loads(request.content))
        return self.response


def responses_body(status: str = "completed", text: str = DOCUMENT) -> dict[str, Any]:
    return {
        "status": status,
        "output": [
            {"type": "reasoning", "content": []},
            {"type": "message", "content": [{"type": "output_text", "text": text}]},
        ],
    }


@pytest.fixture
def files() -> FakeFileStore:
    return FakeFileStore()


@pytest.fixture
def shared() -> FakeShared:
    return FakeShared()


@pytest.fixture
def upstream() -> Upstream:
    return Upstream()


@pytest.fixture
def ctx() -> RunContext[object]:
    deps = AgentRunDeps(
        principal=Principal(
            kind="user",
            user_id=USER,
            permissions=frozenset({"agent:run"}),
            audit_label="logan",
            api_key_id=None,
        ),
        conversation_id="thread-1",
        user_name="logan",
    )
    return RunContext[object](deps=deps, model=TestModel(), usage=RunUsage(), messages=[])


def toolset(
    files: FakeFileStore, shared: FakeShared, upstream: Upstream, sampler: FakeSampler
) -> IclipStudioToolset[object]:
    model = ArkBreakdownModel(
        httpx.AsyncClient(transport=httpx.MockTransport(upstream)),
        url="https://vision.test/responses",
        api_key="ark",
        model="seed-vision",
    )
    return IclipStudio[object](
        space=FileSpace(store=files, namespace=workspace_namespace),
        breakdown=VideoBreakdown(model=model, sampler=sampler),
        shared=shared,
    ).get_toolset()


def user_content(upstream: Upstream) -> list[dict[str, Any]]:
    (request,) = upstream.requests
    return request["input"][1]["content"]


async def test_short_video_is_sent_frame_by_frame_with_timestamps_then_audio(
    files: FakeFileStore, shared: FakeShared, upstream: Upstream, ctx: RunContext[object]
) -> None:
    tools = toolset(files, shared, upstream, FakeSampler(seconds=12.9))

    assert await tools.breakdown_video(ctx, VIDEO) == DONE

    (request,) = upstream.requests
    assert request["model"] == "seed-vision"
    assert request["reasoning"] == {"effort": "high"}
    assert request["max_output_tokens"] == 65_536
    assert request["input"][0]["content"] == [{"type": "input_text", "text": SYSTEM_PROMPT}]
    content = user_content(upstream)
    assert [part["type"] for part in content] == [
        "input_text",
        "input_image",
        "input_text",
        "input_image",
        "input_audio",
        "input_text",
    ]
    assert [content[0]["text"], content[2]["text"]] == ["0.0 second", "0.1 second"]
    assert content[1]["image_url"].startswith("data:image/jpeg;base64,")
    assert content[1]["image_pixel_limit"] == {"max_pixels": 677_376, "min_pixels": 1_764}
    assert content[4]["audio_url"].startswith("data:audio/mpeg;base64,")
    assert content[5]["text"] == USER_MESSAGE


async def test_video_without_an_audio_track_sends_no_audio_part(
    files: FakeFileStore, shared: FakeShared, upstream: Upstream, ctx: RunContext[object]
) -> None:
    tools = toolset(files, shared, upstream, FakeSampler(seconds=5, audio=None))

    await tools.breakdown_video(ctx, VIDEO)

    assert "input_audio" not in [part["type"] for part in user_content(upstream)]


@pytest.mark.parametrize(("seconds", "sampled"), [(60.0, True), (60.1, False)])
async def test_videos_over_a_minute_are_sent_by_address(
    files: FakeFileStore,
    shared: FakeShared,
    upstream: Upstream,
    ctx: RunContext[object],
    seconds: float,
    sampled: bool,
) -> None:
    sampler = FakeSampler(seconds=seconds)
    tools = toolset(files, shared, upstream, sampler)

    await tools.breakdown_video(ctx, VIDEO)

    assert bool(sampler.sampled) is sampled
    if not sampled:
        assert user_content(upstream) == [
            {"type": "input_video", "video_url": VIDEO, "fps": 5},
            {"type": "input_text", "text": USER_MESSAGE},
        ]


async def test_a_fresh_breakdown_is_written_as_is_and_shared(
    files: FakeFileStore, shared: FakeShared, upstream: Upstream, ctx: RunContext[object]
) -> None:
    tools = toolset(files, shared, upstream, FakeSampler(seconds=5))

    await tools.breakdown_video(ctx, VIDEO)

    stored = await files.read(NAMESPACE, PATH)
    assert stored is not None
    assert stored.content == DOCUMENT, "模型写的原文原样保存"
    assert shared.documents == {VIDEO: DOCUMENT}


async def test_a_document_already_in_the_workspace_is_left_alone(
    files: FakeFileStore, shared: FakeShared, upstream: Upstream, ctx: RunContext[object]
) -> None:
    """用户指正过的文档不被共用的原始结果盖掉，也不再调用模型。"""

    await files.write(NAMESPACE, PATH, "用户指正过的文档")
    shared.documents[VIDEO] = DOCUMENT
    tools = toolset(files, shared, upstream, FakeSampler(seconds=5))

    assert await tools.breakdown_video(ctx, VIDEO) == DONE

    stored = await files.read(NAMESPACE, PATH)
    assert stored is not None
    assert stored.content == "用户指正过的文档"
    assert not shared.asked
    assert not upstream.requests


async def test_a_video_broken_down_elsewhere_is_reused_without_the_model(
    files: FakeFileStore, shared: FakeShared, upstream: Upstream, ctx: RunContext[object]
) -> None:
    shared.documents[VIDEO] = DOCUMENT
    tools = toolset(files, shared, upstream, FakeSampler(seconds=5))

    assert await tools.breakdown_video(ctx, VIDEO) == DONE, "复用与新拆返回同一句话"

    stored = await files.read(NAMESPACE, PATH)
    assert stored is not None
    assert stored.content == DOCUMENT
    assert not upstream.requests
    assert not shared.stored, "取来的不再回存"


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(200, json=responses_body(status="incomplete")),
        httpx.Response(200, json=responses_body(text="   ")),
        httpx.Response(500, text="upstream exploded"),
        httpx.Response(200, text="not json"),
    ],
)
async def test_an_unusable_answer_fails_without_leaving_anything_behind(
    files: FakeFileStore,
    shared: FakeShared,
    upstream: Upstream,
    ctx: RunContext[object],
    response: httpx.Response,
) -> None:
    upstream.response = response
    tools = toolset(files, shared, upstream, FakeSampler(seconds=5))

    with pytest.raises(ToolFailed, match="没拆解成功"):
        await tools.breakdown_video(ctx, VIDEO)

    assert await files.read(NAMESPACE, PATH) is None
    assert not shared.stored


async def test_a_video_that_cannot_be_read_fails_before_the_model_is_called(
    files: FakeFileStore, shared: FakeShared, upstream: Upstream, ctx: RunContext[object]
) -> None:
    sampler = FakeSampler(seconds=5)
    sampler.error = MediaError("取不到素材")
    tools = toolset(files, shared, upstream, sampler)

    with pytest.raises(ToolFailed, match="取不到素材"):
        await tools.breakdown_video(ctx, VIDEO)

    assert not upstream.requests


async def test_the_address_must_be_http(
    files: FakeFileStore, shared: FakeShared, upstream: Upstream, ctx: RunContext[object]
) -> None:
    tools = toolset(files, shared, upstream, FakeSampler(seconds=5))
    validator = tools.tools["breakdown_video"].args_validator
    assert validator is not None, "breakdown_video 登记时没挂验证器"

    outcome = validator(ctx, video_url="ref.mp4")
    assert inspect.isawaitable(outcome)
    with pytest.raises(ModelRetry):
        await outcome


def test_documents_of_two_videos_with_the_same_name_do_not_collide() -> None:
    assert breakdown_doc_path("https://a.test/ref.mp4") != breakdown_doc_path(
        "https://b.test/ref.mp4"
    )
    assert PATH.startswith("references/ref-")
    assert PATH.endswith(".md")


def test_the_tool_card_names_the_video(files: FakeFileStore, shared: FakeShared) -> None:
    capability = IclipStudio[object](
        space=FileSpace(store=files, namespace=workspace_namespace),
        breakdown=VideoBreakdown(
            model=ArkBreakdownModel(httpx.AsyncClient(), url="u", api_key="k", model="m"),
            sampler=FakeSampler(seconds=5),
        ),
        shared=shared,
    )

    display = capability.display_table()["breakdown_video"]({"video_url": VIDEO})

    assert display == GenericDisplay(summary="拆解视频", detail="ref.mp4")
