"""用 httpx 替身当音乐生成接口、真实 ffmpeg 规整，验证生成背景音乐发出去的请求、转存与各种收尾。

不调真实付费接口：生成端点与模型给的音频地址都是 MockTransport。"""

from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

import httpx
import pytest

from iclip.domains.generation.models import GenerationJob
from iclip.domains.generation.music import MUSIC_MODEL, PROVIDER_NAME, QwenMusicProvider
from iclip.domains.generation.provider import ProviderError
from iclip.domains.generation.qwen import QwenEndpoint
from iclip.platform.media.process import ffmpeg_available
from tests.helpers.generation import MUSIC_PROMPT, make_music
from tests.helpers.media import duration_ms_of, synthesize_padded_music
from tests.helpers.uploads import FakeBucket

pytestmark = [
    pytest.mark.anyio,
    pytest.mark.skipif(not ffmpeg_available(), reason="本机 PATH 上没有 ffmpeg/ffprobe"),
]

MUSIC_URL = "https://music.test/api/v1/services/audio/tts/SpeechSynthesizer"
SIGNATURE = "sig-only-for-the-model-result"
GENERATED_URL = f"https://result.test/audio/generated.wav?Expires=1789616932&Signature={SIGNATURE}"


def _generated(url: str = GENERATED_URL) -> dict[str, Any]:
    return {
        "request_id": "req-7",
        "output": {
            "finish_reason": "stop",
            "audio": {"url": url, "id": "audio-1", "expires_at": 1789616932, "duration": 5.5},
        },
        "usage": {"duration": 6},
    }


class FakeServices:
    """生成接口与模型给的音频地址的替身：生成端点按剧本回应并记下收到的请求，音频地址给固定字节。"""

    def __init__(self, response: httpx.Response | Exception, audio: bytes | None) -> None:
        self.response = response
        self.audio = audio
        self.generations: list[httpx.Request] = []
        self.downloads: list[httpx.Request] = []

    def transport(self) -> httpx.MockTransport:
        def handler(request: httpx.Request) -> httpx.Response:
            if str(request.url) == MUSIC_URL:
                self.generations.append(request)
                if isinstance(self.response, Exception):
                    raise self.response
                return self.response
            if str(request.url) == GENERATED_URL:
                self.downloads.append(request)
                if self.audio is None:
                    return httpx.Response(403)
                return httpx.Response(200, content=self.audio)
            return httpx.Response(404)

        return httpx.MockTransport(handler)


def _padded_music() -> bytes:
    with TemporaryDirectory(prefix="music-fixture-") as tmp:
        return synthesize_padded_music(Path(tmp) / "generated.wav", lead=1.0, body=3.0, tail=1.5)


def _provider(services: FakeServices, bucket: FakeBucket) -> QwenMusicProvider:
    return QwenMusicProvider(
        QwenEndpoint(url=MUSIC_URL, api_key="sk-test", timeout_seconds=30),
        object_store=bucket,
        transport=services.transport(),
    )


async def _submit_and_fail(services: FakeServices, bucket: FakeBucket) -> ProviderError:
    with pytest.raises(ProviderError) as raised:
        await _provider(services, bucket).submit(make_music())
    assert bucket.written == {}, "失败就不留产物"
    assert SIGNATURE not in str(raised.value), "模型给的签名地址不进错误信息"
    return raised.value


async def test_sends_the_prompt_as_is_then_stores_the_normalized_music() -> None:
    services = FakeServices(httpx.Response(200, json=_generated()), _padded_music())
    bucket = FakeBucket()
    job: GenerationJob = make_music()
    provider = _provider(services, bucket)

    submission = await provider.submit(job)

    assert provider.name == PROVIDER_NAME
    (sent,) = services.generations
    assert sent.headers["Authorization"] == "Bearer sk-test"
    assert json.loads(sent.content) == {
        "model": MUSIC_MODEL,
        "input": {
            "text_prompt": MUSIC_PROMPT,
            "format": "wav",
            "sample_rate": 48000,
            "channels": 2,
        },
    }, "提示词原样发出，不补任何文字"
    key = f"iclip/agent/generated-music/{job.id}.m4a"
    assert submission.output_url == bucket.public_url(key)
    assert bucket.objects[key].content_type == "audio/mp4"
    content, _ = bucket.written[key]
    assert submission.duration_ms is not None
    assert abs(submission.duration_ms - 3000) <= 50, "时长是规整后量的，不是模型报的 5.5 秒"
    assert abs(await duration_ms_of(content) - submission.duration_ms) <= 50
    assert submission.provider_task_id == "req-7"
    assert SIGNATURE not in (submission.output_url or ""), "不留模型给的临时地址"


@pytest.mark.parametrize(
    ("response", "code"),
    [
        (
            httpx.Response(
                400, json={"code": "CLIENT_ERROR", "message": "text_prompt exceeds 3000"}
            ),
            "PROVIDER_REJECTED",
        ),
        (httpx.Response(429, json={"code": "Throttling.RateQuota"}), "PROVIDER_REJECTED"),
        (httpx.Response(500, json={"code": "InternalError"}), "PROVIDER_SERVER_ERROR"),
        (httpx.Response(200, text="not json"), "PROVIDER_MALFORMED"),
        (httpx.Response(200, json=["not", "an", "object"]), "PROVIDER_MALFORMED"),
        (httpx.Response(200, json={"request_id": "r", "output": {}}), "PROVIDER_MALFORMED"),
        (httpx.Response(200, json=_generated(url="not-a-url")), "PROVIDER_MALFORMED"),
        (httpx.ReadTimeout("等不到"), "PROVIDER_RESULT_UNKNOWN"),
        (httpx.ConnectError("连不上"), "PROVIDER_UNREACHABLE"),
    ],
    ids=[
        "拒绝",
        "限流",
        "5xx",
        "不是 JSON",
        "根不是对象",
        "没有音频",
        "地址不合法",
        "读超时",
        "连不上",
    ],
)
async def test_service_failures_carry_a_code_that_tells_whether_it_was_received(
    response: httpx.Response | Exception, code: str
) -> None:
    services = FakeServices(response, _padded_music())

    failure = await _submit_and_fail(services, FakeBucket())

    assert failure.code == code
    assert len(services.generations) == 1, "只发一次，不自己重试"


@pytest.mark.parametrize(
    "request_id_fields",
    [{}, {"request_id": ""}, {"request_id": " \t\n"}, {"request_id": None}, {"request_id": 42}],
    ids=["missing", "empty", "whitespace", "null", "number"],
)
async def test_an_invalid_request_id_fails_before_the_result_is_fetched_or_stored(
    request_id_fields: dict[str, Any],
) -> None:
    body = {key: value for key, value in _generated().items() if key != "request_id"}
    services = FakeServices(httpx.Response(200, json=body | request_id_fields), _padded_music())

    failure = await _submit_and_fail(services, FakeBucket())

    assert failure.code == "PROVIDER_MALFORMED"
    assert "request_id" in str(failure)
    assert services.downloads == [], "回执不合格就不去取模型给的音频"
    assert len(services.generations) == 1, "缺少有效回执也不能重投生成"


async def test_a_result_that_cannot_be_downloaded_fails_without_its_address() -> None:
    services = FakeServices(httpx.Response(200, json=_generated()), audio=None)

    failure = await _submit_and_fail(services, FakeBucket())

    assert failure.code == "OUTPUT_DOWNLOAD_FAILED"
    assert "result.test" not in str(failure)
    assert len(services.generations) == 1, "已经计费，不重新生成"


async def test_a_result_that_cannot_be_normalized_is_a_processing_failure() -> None:
    services = FakeServices(httpx.Response(200, json=_generated()), b"not audio")

    failure = await _submit_and_fail(services, FakeBucket())

    assert failure.code == "MEDIA_PROCESS_FAILED"


async def test_all_silence_from_the_model_is_a_processing_failure() -> None:
    with TemporaryDirectory(prefix="music-fixture-") as tmp:
        silent = synthesize_padded_music(
            Path(tmp) / "silent.wav", lead=1.0, body=1.0, tail=1.0, volume=0
        )
    services = FakeServices(httpx.Response(200, json=_generated()), silent)

    failure = await _submit_and_fail(services, FakeBucket())

    assert failure.code == "MEDIA_PROCESS_FAILED"


async def test_a_bucket_that_refuses_the_music_fails_the_generation() -> None:
    services = FakeServices(httpx.Response(200, json=_generated()), _padded_music())
    bucket = FakeBucket()
    bucket.put_fails = True

    failure = await _submit_and_fail(services, bucket)

    assert failure.code == "OUTPUT_STORE_FAILED"


async def test_there_is_no_polling_phase() -> None:
    services = FakeServices(httpx.Response(200, json=_generated()), None)

    with pytest.raises(ProviderError) as raised:
        await _provider(services, FakeBucket()).poll(make_music())
    assert raised.value.code == "PROVIDER_POLL_UNSUPPORTED"
