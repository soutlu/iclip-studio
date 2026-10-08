"""验证一次视频拆解：按时长选路、请求形状，以及哪些失败值得再拆一次。"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from iclip.capabilities.iclip_studio.breakdown.model import ArkBreakdownModel
from iclip.capabilities.iclip_studio.breakdown.prompt import SYSTEM_PROMPT, USER_MESSAGE
from iclip.capabilities.iclip_studio.breakdown.service import VideoBreakdown
from iclip.capabilities.iclip_studio.ports import BreakdownError, SampledVideo
from iclip.platform.media.ffmpeg import MediaError

VIDEO = "https://cdn.test/ref.mp4"
DOCUMENT = "# 出场元素\n……\n# 时间线\n……\n# 整片分析\n……"


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
def upstream() -> Upstream:
    return Upstream()


def breakdown_with(
    sampler: FakeSampler,
    upstream: Upstream | None = None,
    *,
    transport: httpx.MockTransport | None = None,
) -> VideoBreakdown:
    model = ArkBreakdownModel(
        httpx.AsyncClient(transport=transport or httpx.MockTransport(upstream or Upstream())),
        url="https://vision.test/responses",
        api_key="ark",
        model="seed-vision",
    )
    return VideoBreakdown(model=model, sampler=sampler)


def user_content(upstream: Upstream) -> list[dict[str, Any]]:
    (request,) = upstream.requests
    return request["input"][1]["content"]


async def test_short_video_is_sent_frame_by_frame_with_timestamps_then_audio(
    upstream: Upstream,
) -> None:
    breakdown = breakdown_with(FakeSampler(seconds=12.9), upstream)

    assert await breakdown.run(VIDEO) == DOCUMENT, "模型写的原文原样交回"

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
    """4xx 是请求本身被拒，原样再发一次也是白付。"""

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


async def test_a_video_that_cannot_be_read_fails_before_the_model_is_called(
    upstream: Upstream,
) -> None:
    sampler = FakeSampler(seconds=5)
    sampler.error = MediaError("ffprobe 失败（退出码 1）")

    with pytest.raises(MediaError):
        await breakdown_with(sampler, upstream).run(VIDEO)

    assert not upstream.requests
