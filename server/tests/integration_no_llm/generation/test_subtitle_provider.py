"""用真实 ffmpeg 抽音轨、httpx 替身当识别接口，验证字幕识别发出去的请求与各种收尾。

不调真实付费接口：识别端点是 MockTransport。"""

from __future__ import annotations

import base64
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

import httpx
import pytest

from iclip.domains.generation.provider import ProviderError
from iclip.domains.generation.schemas import SubtitleSentence
from iclip.domains.generation.subtitles import (
    PROVIDER_NAME,
    SUBTITLE_MODEL,
    QwenSubtitleProvider,
    SubtitleProviderSettings,
)
from iclip.platform.media.process import ffmpeg_available
from tests.helpers.fetch_url import as_is
from tests.helpers.generation import make_job, make_subtitle
from tests.helpers.media import synthesize_video

pytestmark = [
    pytest.mark.anyio,
    pytest.mark.skipif(not ffmpeg_available(), reason="本机 PATH 上没有 ffmpeg/ffprobe"),
]

VIDEO_URL = "https://cdn.test/iclip/video/take.mp4"
ASR_URL = "https://asr.test/api/v1/services/aigc/multimodal-generation/generation"

RECOGNIZED: dict[str, Any] = {
    "output": {
        "sentence": {"begin_time": 2000, "end_time": 3000, "text": "第二句。", "speaker_id": 1},
        "sentences": [
            {"begin_time": 100, "end_time": 1800, "text": "第一句。", "speaker_id": 0},
            {"begin_time": 2000, "end_time": 3000, "text": "第二句。", "speaker_id": 1},
        ],
        "text": "第一句。第二句。",
    },
    "usage": {"duration": 3},
    "request_id": "req-42",
}
NO_WORDS = {
    "request_id": "req-no-words",
    "code": "CLIENT_ERROR",
    "message": "ASR_RESPONSE_HAVE_NO_WORDS",
}


class FakeServices:
    """取视频与识别接口的替身：视频地址给固定字节，识别端点按剧本回应并记下收到的请求。"""

    def __init__(self, video: bytes | None, response: httpx.Response | Exception) -> None:
        self.video = video
        self.response = response
        self.recognitions: list[httpx.Request] = []

    def transport(self) -> httpx.MockTransport:
        def handler(request: httpx.Request) -> httpx.Response:
            if str(request.url) == VIDEO_URL:
                if self.video is None:
                    return httpx.Response(404)
                return httpx.Response(200, content=self.video)
            if str(request.url) == ASR_URL:
                self.recognitions.append(request)
                if isinstance(self.response, Exception):
                    raise self.response
                return self.response
            return httpx.Response(404)

        return httpx.MockTransport(handler)


def _video(*, audio: bool) -> bytes:
    with TemporaryDirectory(prefix="subtitle-fixture-") as tmp:
        return synthesize_video(Path(tmp) / "take.mp4", size="160x120", seconds=2, audio=audio)


def _provider(services: FakeServices) -> QwenSubtitleProvider:
    return QwenSubtitleProvider(
        SubtitleProviderSettings(url=ASR_URL, api_key="sk-test", timeout_seconds=30),
        fetch_url=as_is,
        transport=services.transport(),
    )


def _subtitle_job() -> Any:
    take = make_job(output_url=VIDEO_URL, status="completed")
    return make_subtitle(take)


async def test_sends_mono_mp3_as_base64_with_diarization_and_maps_every_sentence() -> None:
    services = FakeServices(_video(audio=True), httpx.Response(200, json=RECOGNIZED))
    provider = _provider(services)

    submission = await provider.submit(_subtitle_job())

    assert provider.name == PROVIDER_NAME
    assert submission.sentences == (
        SubtitleSentence(start_ms=100, end_ms=1800, text="第一句。", speaker=0),
        SubtitleSentence(start_ms=2000, end_ms=3000, text="第二句。", speaker=1),
    )
    assert submission.provider_task_id == "req-42"
    assert submission.output_url is None
    (sent,) = services.recognitions
    assert sent.headers["Authorization"] == "Bearer sk-test"
    assert sent.headers["X-DashScope-SSE"] == "disable"
    body = json.loads(sent.content)
    assert body["model"] == SUBTITLE_MODEL
    assert body["parameters"] == {
        "format": "mp3",
        "sample_rate": "16000",
        "speaker_diarization_enabled": True,
    }
    (message,) = body["input"]["messages"]
    (part,) = message["content"]
    assert (message["role"], part["type"]) == ("user", "input_audio")
    prefix, _, encoded = part["input_audio"]["data"].partition(",")
    assert prefix == "data:audio/mp3;base64"
    assert base64.b64decode(encoded)[:3] in (b"ID3", b"\xff\xfb", b"\xff\xf3"), "发的是 mp3 字节"


async def test_a_video_without_audio_is_no_voice_over_and_the_service_is_not_called() -> None:
    services = FakeServices(_video(audio=False), httpx.Response(200, json=RECOGNIZED))
    job = _subtitle_job()

    submission = await _provider(services).submit(job)

    assert submission.sentences == ()
    assert submission.provider_task_id == str(job.id)
    assert submission.provider_status == "no_audio"
    assert services.recognitions == [], "没有声音就不付费调接口"


async def test_audio_without_speech_is_a_normal_empty_result() -> None:
    """有声音却没人说话（只有音乐）：识别服务明确返回空数组，这是正常结果。"""

    services = FakeServices(
        _video(audio=True),
        httpx.Response(200, json={"output": {"text": "", "sentences": []}, "request_id": "req-0"}),
    )

    submission = await _provider(services).submit(_subtitle_job())

    assert submission.sentences == ()
    assert len(services.recognitions) == 1


async def test_no_words_response_is_an_empty_result_with_upstream_diagnostics() -> None:
    services = FakeServices(
        _video(audio=True),
        httpx.Response(400, json=NO_WORDS),
    )

    submission = await _provider(services).submit(_subtitle_job())

    assert submission.sentences == ()
    assert submission.provider_task_id == "req-no-words"
    assert submission.provider_status == "ASR_RESPONSE_HAVE_NO_WORDS"
    assert submission.output_url is None
    assert len(services.recognitions) == 1, "空口播已是最终结果，不重试识别"


@pytest.mark.parametrize(
    ("status", "response_body"),
    [(200, RECOGNIZED), (400, NO_WORDS)],
    ids=["recognized", "no-words"],
)
@pytest.mark.parametrize(
    "request_id_fields",
    [{}, {"request_id": ""}, {"request_id": " \t\n"}, {"request_id": None}, {"request_id": 42}],
    ids=["missing", "empty", "whitespace", "null", "number"],
)
async def test_an_invalid_request_id_is_a_malformed_response(
    status: int, response_body: dict[str, Any], request_id_fields: dict[str, Any]
) -> None:
    body = {key: value for key, value in response_body.items() if key != "request_id"}
    services = FakeServices(
        _video(audio=True), httpx.Response(status, json=body | request_id_fields)
    )

    with pytest.raises(ProviderError, match="request_id") as raised:
        await _provider(services).submit(_subtitle_job())

    assert raised.value.code == "PROVIDER_MALFORMED"
    assert raised.value.retryable is False
    assert len(services.recognitions) == 1, "缺少有效回执也不能重投识别"


async def test_an_unreachable_video_is_an_explicit_failure() -> None:
    services = FakeServices(None, httpx.Response(200, json=RECOGNIZED))

    with pytest.raises(ProviderError) as raised:
        await _provider(services).submit(_subtitle_job())
    assert raised.value.code == "MEDIA_SOURCE_UNREACHABLE"
    assert services.recognitions == []


async def test_a_broken_video_is_a_processing_failure() -> None:
    services = FakeServices(b"not a video", httpx.Response(200, json=RECOGNIZED))

    with pytest.raises(ProviderError) as raised:
        await _provider(services).submit(_subtitle_job())
    assert raised.value.code == "MEDIA_PROCESS_FAILED"
    assert services.recognitions == []


@pytest.mark.parametrize(
    ("response", "code"),
    [
        (
            httpx.Response(400, json={"code": "InvalidParameter", "message": "坏了"}),
            "PROVIDER_REJECTED",
        ),
        pytest.param(
            httpx.Response(400, json=NO_WORDS | {"message": "INVALID_AUDIO"}),
            "PROVIDER_REJECTED",
            id="other-client-error",
        ),
        pytest.param(
            httpx.Response(400, json=NO_WORDS | {"message": "ASR_RESPONSE_HAVE_NO_WORDS: detail"}),
            "PROVIDER_REJECTED",
            id="no-words-substring",
        ),
        pytest.param(
            httpx.Response(400, json=NO_WORDS | {"code": "ASR_RESPONSE_HAVE_NO_WORDS"}),
            "PROVIDER_REJECTED",
            id="different-error-shape",
        ),
        pytest.param(
            httpx.Response(
                400, json=NO_WORDS | {"message": {"code": "ASR_RESPONSE_HAVE_NO_WORDS"}}
            ),
            "PROVIDER_REJECTED",
            id="malformed-error-message",
        ),
        pytest.param(
            httpx.Response(400, json=[NO_WORDS]),
            "PROVIDER_REJECTED",
            id="malformed-error-root",
        ),
        pytest.param(
            httpx.Response(400, text="ASR_RESPONSE_HAVE_NO_WORDS"),
            "PROVIDER_REJECTED",
            id="non-json-error",
        ),
        pytest.param(httpx.Response(401, json=NO_WORDS), "PROVIDER_REJECTED", id="unauthenticated"),
        pytest.param(httpx.Response(403, json=NO_WORDS), "PROVIDER_REJECTED", id="forbidden"),
        pytest.param(
            httpx.Response(500, json=NO_WORDS), "PROVIDER_SERVER_ERROR", id="server-error"
        ),
        (httpx.Response(503, text="busy"), "PROVIDER_SERVER_ERROR"),
        pytest.param(
            httpx.Response(200, json=NO_WORDS), "PROVIDER_MALFORMED", id="success-without-output"
        ),
        pytest.param(
            httpx.Response(200, json={"output": {"text": ""}, "request_id": "req-0"}),
            "PROVIDER_MALFORMED",
            id="success-without-sentences",
        ),
        pytest.param(
            httpx.Response(200, json=[RECOGNIZED]),
            "PROVIDER_MALFORMED",
            id="malformed-success-root",
        ),
        (httpx.Response(200, text="not json"), "PROVIDER_MALFORMED"),
        (httpx.ReadTimeout("等不到"), "PROVIDER_RESULT_UNKNOWN"),
        (httpx.ConnectError("连不上"), "PROVIDER_UNREACHABLE"),
    ],
)
async def test_service_failures_carry_a_code_that_tells_whether_it_was_received(
    response: httpx.Response | Exception, code: str
) -> None:
    services = FakeServices(_video(audio=True), response)

    with pytest.raises(ProviderError) as raised:
        await _provider(services).submit(_subtitle_job())
    assert raised.value.code == code
    assert raised.value.retryable is (code in {"PROVIDER_UNREACHABLE", "PROVIDER_SERVER_ERROR"})
    assert len(services.recognitions) == 1, "只发一次，不自己重试"


async def test_there_is_no_polling_phase() -> None:
    services = FakeServices(None, httpx.Response(200, json=RECOGNIZED))

    with pytest.raises(ProviderError) as raised:
        await _provider(services).poll(_subtitle_job())
    assert raised.value.code == "PROVIDER_POLL_UNSUPPORTED"
