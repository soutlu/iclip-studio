from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
from cue.client import RuntimeClient

from iclip.platform.media.errors import MediaError
from iclip.platform.video_breakdown.model import BREAKDOWN_MODEL, ArkBreakdownModel
from iclip.platform.video_breakdown.ports import (
    BreakdownError,
    BreakdownModelUnavailable,
    SampledVideo,
)
from iclip.platform.video_breakdown.prompt import SYSTEM_PROMPT, USER_MESSAGE
from iclip.platform.video_breakdown.service import BreakdownRunner

RUNTIME = "http://runtime.test"
APP_KEY = "app-key-test-0123456789-0123456789"
VIDEO = "https://cdn.test/ref.mp4"
DOCUMENT = "# 出场元素\n……\n# 时间线\n……\n# 整片分析\n……"


class FakeSampler:
    def __init__(self, *, seconds: float, audio: bytes | None = b"mp3") -> None:
        self.seconds = seconds
        self.audio = audio
        self.sampled: list[str] = []
        self.error: MediaError | None = None

    async def sample_up_to(self, video_url: str, *, max_seconds: float) -> SampledVideo | None:
        if self.error is not None:
            raise self.error
        if self.seconds > max_seconds:
            return None
        self.sampled.append(video_url)
        return SampledVideo(frames=(b"frame-0", b"frame-1"), audio=self.audio)


class Upstream:
    def __init__(self) -> None:
        self.calls: list[httpx.Request] = []
        self.response = httpx.Response(200, json=responses_body())

    @property
    def requests(self) -> list[dict[str, Any]]:
        return [json.loads(call.content)["payload"] for call in self.calls]

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
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
def upstream() -> Upstream:
    return Upstream()


def breakdown_with(
    sampler: FakeSampler,
    upstream: Upstream | None = None,
    *,
    transport: httpx.MockTransport | None = None,
) -> BreakdownRunner:
    runtime = RuntimeClient(
        RUNTIME,
        APP_KEY,
        transport=transport or httpx.MockTransport(upstream or Upstream()),
    )
    model = ArkBreakdownModel(runtime, model=BREAKDOWN_MODEL)
    return BreakdownRunner(model=model, sampler=sampler)


async def test_the_call_goes_through_the_runtimes_model_call_with_a_longer_wait(
    upstream: Upstream,
) -> None:
    await breakdown_with(FakeSampler(seconds=5), upstream).run(VIDEO)

    (call,) = upstream.calls
    assert str(call.url) == f"{RUNTIME}/v1/model-calls/responses"
    assert call.headers["Authorization"] == f"Bearer {APP_KEY}"
    body = json.loads(call.content)
    assert (body["declaration"], body["model"]) == ("volcengine", "doubao-seed-2-1-lite-260915")
    assert call.extensions["timeout"]["read"] > 900


def user_content(upstream: Upstream) -> list[dict[str, Any]]:
    (request,) = upstream.requests
    return request["input"][1]["content"]


async def test_short_video_is_sent_frame_by_frame_with_timestamps_then_audio(
    upstream: Upstream,
) -> None:
    breakdown = breakdown_with(FakeSampler(seconds=12.9), upstream)

    assert await breakdown.run(VIDEO) == DOCUMENT, "模型写的原文原样交回"

    (request,) = upstream.requests
    assert request["model"] == "doubao-seed-2-1-lite-260915"
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


async def test_video_without_an_audio_track_sends_no_audio_part(upstream: Upstream) -> None:
    await breakdown_with(FakeSampler(seconds=5, audio=None), upstream).run(VIDEO)

    assert "input_audio" not in [part["type"] for part in user_content(upstream)]


@pytest.mark.parametrize(("seconds", "sampled"), [(60.0, True), (60.1, False)])
async def test_videos_over_a_minute_are_sent_by_address(
    upstream: Upstream, seconds: float, sampled: bool
) -> None:
    sampler = FakeSampler(seconds=seconds)

    await breakdown_with(sampler, upstream).run(VIDEO)

    assert bool(sampler.sampled) is sampled
    if not sampled:
        assert user_content(upstream) == [
            {"type": "input_video", "video_url": VIDEO, "fps": 5},
            {"type": "input_text", "text": USER_MESSAGE},
        ]


RETRYABLE = [
    httpx.Response(200, json=responses_body(status="incomplete")),
    httpx.Response(200, json=responses_body(text="   ")),
    httpx.Response(500, text="upstream exploded"),
    httpx.Response(429, text="slow down"),
    httpx.Response(200, text="not json"),
    httpx.Response(502, json={"detail": "连不上上游", "code": "upstream_unreachable"}),
]


@pytest.mark.parametrize("response", RETRYABLE)
async def test_an_unusable_answer_is_worth_another_breakdown(
    upstream: Upstream, response: httpx.Response
) -> None:
    upstream.response = response

    with pytest.raises(BreakdownError) as raised:
        await breakdown_with(FakeSampler(seconds=5), upstream).run(VIDEO)

    assert raised.value.retryable


async def test_a_rejected_request_is_not_worth_another_breakdown(upstream: Upstream) -> None:
    upstream.response = httpx.Response(400, text="payload too large")

    with pytest.raises(BreakdownError) as raised:
        await breakdown_with(FakeSampler(seconds=5), upstream).run(VIDEO)

    assert not raised.value.retryable


async def test_a_timeout_is_not_worth_another_breakdown() -> None:
    def hang(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out", request=request)

    breakdown = breakdown_with(FakeSampler(seconds=5), transport=httpx.MockTransport(hang))

    with pytest.raises(BreakdownError) as raised:
        await breakdown.run(VIDEO)

    assert not raised.value.retryable


async def test_the_runtime_timing_out_on_ark_is_not_worth_another_breakdown(
    upstream: Upstream,
) -> None:
    upstream.response = httpx.Response(504, json={"detail": "超时", "code": "upstream_timeout"})

    with pytest.raises(BreakdownError) as raised:
        await breakdown_with(FakeSampler(seconds=5), upstream).run(VIDEO)

    assert not raised.value.retryable
    assert not isinstance(raised.value, BreakdownModelUnavailable)


async def test_an_unreachable_runtime_is_worth_another_breakdown() -> None:
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    breakdown = breakdown_with(FakeSampler(seconds=5), transport=httpx.MockTransport(refuse))

    with pytest.raises(BreakdownError) as raised:
        await breakdown.run(VIDEO)

    assert raised.value.retryable


async def test_a_model_not_enabled_on_the_config_page_is_its_own_final_failure(
    upstream: Upstream,
) -> None:
    reason = "配置页的火山方舟里没有启用的模型 doubao-seed-2-1-lite-260915（或没有默认密钥）"
    upstream.response = httpx.Response(409, json={"detail": reason, "code": "model_unavailable"})

    with pytest.raises(BreakdownModelUnavailable, match=r"没有启用的模型") as raised:
        await breakdown_with(FakeSampler(seconds=5), upstream).run(VIDEO)

    assert not raised.value.retryable
    assert str(raised.value) == reason


async def test_a_video_that_cannot_be_read_fails_before_the_model_is_called(
    upstream: Upstream,
) -> None:
    sampler = FakeSampler(seconds=5)
    sampler.error = MediaError("ffprobe 失败（退出码 1）")

    with pytest.raises(MediaError):
        await breakdown_with(sampler, upstream).run(VIDEO)

    assert not upstream.requests
