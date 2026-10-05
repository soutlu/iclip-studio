"""验证视频拆解工具：按时长选路、请求形状、响应校验，以及工作区与共用结果的复用。"""

from __future__ import annotations

import inspect
import json
import uuid
from typing import Any

import httpx
import pytest
from pydantic_ai import Agent, ModelRetry, ToolFailed
from pydantic_ai.messages import (
    ModelMessage,
    ModelResponse,
    RetryPromptPart,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
)
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.models.test import TestModel
from pydantic_ai.tools import RunContext
from pydantic_ai.usage import RunUsage

from iclip.capabilities.iclip_studio.breakdown.model import ArkBreakdownModel
from iclip.capabilities.iclip_studio.breakdown.prompt import SYSTEM_PROMPT, USER_MESSAGE
from iclip.capabilities.iclip_studio.breakdown.service import VideoBreakdown
from iclip.capabilities.iclip_studio.capability import (
    BREAKDOWN_RETRIES,
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


def make_deps() -> AgentRunDeps:
    return AgentRunDeps(
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


def make_ctx(*, retry: int = 0) -> RunContext[object]:
    """第 ``retry`` 次重试时的运行上下文；预算与工具登记的一致。"""

    return RunContext[object](
        deps=make_deps(),
        model=TestModel(),
        usage=RunUsage(),
        messages=[],
        retry=retry,
        max_retries=BREAKDOWN_RETRIES,
    )


@pytest.fixture
def ctx() -> RunContext[object]:
    return make_ctx()


def capability_for(
    files: FakeFileStore, shared: FakeShared, upstream: Upstream, sampler: FakeSampler
) -> IclipStudio[object]:
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
    )


def toolset(
    files: FakeFileStore, shared: FakeShared, upstream: Upstream, sampler: FakeSampler
) -> IclipStudioToolset[object]:
    return capability_for(files, shared, upstream, sampler).get_toolset()


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


RETRYABLE = [
    httpx.Response(200, json=responses_body(status="incomplete")),
    httpx.Response(200, json=responses_body(text="   ")),
    httpx.Response(500, text="upstream exploded"),
    httpx.Response(429, text="slow down"),
    httpx.Response(200, text="not json"),
]


@pytest.mark.parametrize("response", RETRYABLE)
async def test_an_unusable_answer_asks_for_another_call_and_leaves_nothing_behind(
    files: FakeFileStore,
    shared: FakeShared,
    upstream: Upstream,
    ctx: RunContext[object],
    response: httpx.Response,
) -> None:
    upstream.response = response
    tools = toolset(files, shared, upstream, FakeSampler(seconds=5))

    with pytest.raises(ModelRetry) as raised:
        await tools.breakdown_video(ctx, VIDEO)

    assert raised.value.message == "拆解失败，再调用一次。", "原始报错只进日志，不给模型"
    assert await files.read(NAMESPACE, PATH) is None
    assert not shared.stored


async def test_the_last_allowed_attempt_ends_in_a_final_failure(
    files: FakeFileStore, shared: FakeShared, upstream: Upstream
) -> None:
    upstream.response = httpx.Response(500, text="upstream exploded")
    tools = toolset(files, shared, upstream, FakeSampler(seconds=5))

    with pytest.raises(ToolFailed) as raised:
        await tools.breakdown_video(make_ctx(retry=BREAKDOWN_RETRIES), VIDEO)

    assert raised.value.message == "拆解失败，不要重试，告诉用户稍后再试。"


async def test_a_rejected_request_is_not_retried(
    files: FakeFileStore, shared: FakeShared, upstream: Upstream, ctx: RunContext[object]
) -> None:
    """4xx 是请求本身被拒，原样再发一次也是白付。"""

    upstream.response = httpx.Response(400, text="payload too large")
    tools = toolset(files, shared, upstream, FakeSampler(seconds=5))

    with pytest.raises(ToolFailed, match="不要重试，告诉用户稍后再试"):
        await tools.breakdown_video(ctx, VIDEO)


async def test_a_timeout_is_not_retried(
    files: FakeFileStore, shared: FakeShared, ctx: RunContext[object]
) -> None:
    def hang(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out", request=request)

    model = ArkBreakdownModel(
        httpx.AsyncClient(transport=httpx.MockTransport(hang)),
        url="https://vision.test/responses",
        api_key="ark",
        model="seed-vision",
    )
    tools = IclipStudio[object](
        space=FileSpace(store=files, namespace=workspace_namespace),
        breakdown=VideoBreakdown(model=model, sampler=FakeSampler(seconds=5)),
        shared=shared,
    ).get_toolset()

    with pytest.raises(ToolFailed, match="不要重试，告诉用户稍后再试"):
        await tools.breakdown_video(ctx, VIDEO)


async def test_a_video_that_cannot_be_read_fails_before_the_model_is_called(
    files: FakeFileStore, shared: FakeShared, upstream: Upstream, ctx: RunContext[object]
) -> None:
    sampler = FakeSampler(seconds=5)
    sampler.error = MediaError("ffprobe 失败（退出码 1）")
    tools = toolset(files, shared, upstream, sampler)

    with pytest.raises(ToolFailed) as raised:
        await tools.breakdown_video(ctx, VIDEO)

    assert raised.value.message == "拆解失败，视频无法打开，不要重试，告诉用户换一条视频。"
    assert not upstream.requests


async def run_agent_that_keeps_calling(
    capability: IclipStudio[object], *, video_url: str = VIDEO
) -> list[ModelMessage]:
    """模型每次收到重试提示就原样再调一次，直到拿到工具结果。"""

    def script(messages: list[ModelMessage], _info: AgentInfo) -> ModelResponse:
        last = messages[-1].parts[-1]
        if len(messages) == 1 or isinstance(last, RetryPromptPart):
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        "breakdown_video",
                        {"video_url": video_url},
                        tool_call_id=f"c{len(messages)}",
                    )
                ]
            )
        return ModelResponse(parts=[TextPart("本轮结束。")])

    result = await Agent(FunctionModel(script), capabilities=[capability]).run(
        "拆解参考视频。", deps=make_deps()
    )
    return result.all_messages()


async def test_a_failing_upstream_is_called_four_times_and_the_run_survives(
    files: FakeFileStore, shared: FakeShared, upstream: Upstream
) -> None:
    """首次加三次重试；预算用完后模型拿到的是失败结果，整次运行不被中止。"""

    upstream.response = httpx.Response(500, text="upstream exploded")
    capability = capability_for(files, shared, upstream, FakeSampler(seconds=5))

    messages = await run_agent_that_keeps_calling(capability)

    assert len(upstream.requests) == 1 + BREAKDOWN_RETRIES
    retries = [p for m in messages for p in m.parts if isinstance(p, RetryPromptPart)]
    assert len(retries) == BREAKDOWN_RETRIES
    (final,) = [p for m in messages for p in m.parts if isinstance(p, ToolReturnPart)]
    assert "不要重试，告诉用户稍后再试" in final.model_response_str()


async def test_a_retry_that_succeeds_delivers_the_document(
    files: FakeFileStore, shared: FakeShared
) -> None:
    answers = [
        httpx.Response(200, json=responses_body(status="incomplete")),
        httpx.Response(200, json=responses_body()),
    ]
    upstream = Upstream()
    calls = iter(answers)

    def answer(request: httpx.Request) -> httpx.Response:
        upstream.requests.append(json.loads(request.content))
        return next(calls)

    model = ArkBreakdownModel(
        httpx.AsyncClient(transport=httpx.MockTransport(answer)),
        url="https://vision.test/responses",
        api_key="ark",
        model="seed-vision",
    )
    capability = IclipStudio[object](
        space=FileSpace(store=files, namespace=workspace_namespace),
        breakdown=VideoBreakdown(model=model, sampler=FakeSampler(seconds=5)),
        shared=shared,
    )

    messages = await run_agent_that_keeps_calling(capability)

    (final,) = [p for m in messages for p in m.parts if isinstance(p, ToolReturnPart)]
    assert final.model_response_str() == DONE
    stored = await files.read(NAMESPACE, PATH)
    assert stored is not None
    assert stored.content == DOCUMENT


async def test_the_address_must_be_http(
    files: FakeFileStore, shared: FakeShared, upstream: Upstream, ctx: RunContext[object]
) -> None:
    tools = toolset(files, shared, upstream, FakeSampler(seconds=5))
    validator = tools.tools["breakdown_video"].args_validator
    assert validator is not None, "breakdown_video 登记时没挂验证器"

    outcome = validator(ctx, video_url="ref.mp4")
    assert inspect.isawaitable(outcome)
    with pytest.raises(ModelRetry) as raised:
        await outcome
    assert raised.value.message == "视频地址不对，输入提供的视频的 url。"


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
