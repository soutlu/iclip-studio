from __future__ import annotations

import base64
import json
from typing import Any

import httpx
import pytest

from iclip.common.final_cut import TargetLocale
from iclip.domains.generation.provider import ProviderError
from iclip.domains.generation.qwen import QwenEndpoint
from iclip.domains.generation.speech import SPEECH_MODEL, QwenSpeechSynthesizer

SPEECH_URL = "https://tts.test/api/v1/services/audio/tts/SpeechSynthesizer"
SIGNATURE = "sig-only-for-the-model-result"
GENERATED_URL = f"https://result.test/audio/speech.wav?Expires=1789616932&Signature={SIGNATURE}"
REFERENCE = b"RIFF-reference-voice"
SPOKEN = b"RIFF-synthesized-line"


def _generated(url: str = GENERATED_URL) -> dict[str, Any]:
    return {
        "request_id": "req-9",
        "output": {
            "finish_reason": "stop",
            "audio": {"url": url, "id": "audio-9", "expires_at": 1789616932, "duration": 1.2},
        },
        "usage": {"duration": 1},
    }


class FakeServices:
    def __init__(self, response: httpx.Response | Exception, audio: bytes | None) -> None:
        self.response = response
        self.audio = audio
        self.syntheses: list[httpx.Request] = []
        self.downloads: list[httpx.Request] = []

    def transport(self) -> httpx.MockTransport:
        def handler(request: httpx.Request) -> httpx.Response:
            if str(request.url) == SPEECH_URL:
                self.syntheses.append(request)
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


def _synthesizer(services: FakeServices) -> QwenSpeechSynthesizer:
    return QwenSpeechSynthesizer(
        QwenEndpoint(url=SPEECH_URL, api_key="sk-test", timeout_seconds=30),
        transport=services.transport(),
    )


async def _synthesize_and_fail(services: FakeServices) -> ProviderError:
    with pytest.raises(ProviderError) as raised:
        await _synthesizer(services).synthesize(
            "Hello", reference=REFERENCE, locale="en", api_key=None
        )
    assert SIGNATURE not in str(raised.value), "模型给的签名地址不进错误信息"
    assert len(services.syntheses) == 1, "只发一次，不自己重试"
    return raised.value


@pytest.mark.parametrize(
    ("locale", "language"),
    [("zh", "中文"), ("en", "英语"), ("de", "德语"), ("es", "西班牙语"), ("fr", "法语")],
)
async def test_speaks_the_line_in_the_reference_voice_and_returns_the_downloaded_audio(
    locale: TargetLocale, language: str
) -> None:
    services = FakeServices(httpx.Response(200, json=_generated()), SPOKEN)

    audio = await _synthesizer(services).synthesize(
        "Bonjour à tous", reference=REFERENCE, locale=locale, api_key=None
    )

    assert audio == SPOKEN
    (sent,) = services.syntheses
    assert sent.headers["Authorization"] == "Bearer sk-test"
    body = json.loads(sent.content)
    voice = f"data:audio/wav;base64,{base64.b64encode(REFERENCE).decode('ascii')}"
    assert body == {
        "model": SPEECH_MODEL,
        "input": {
            "text_prompt": f"@voice1 用{language}说：“Bonjour à tous”",
            "references": [{"audio_data": voice}],
            "format": "wav",
            "sample_rate": 48000,
            "channels": 1,
        },
    }
    assert [str(request.url) for request in services.downloads] == [GENERATED_URL]


async def test_a_group_key_replaces_the_default_one() -> None:
    services = FakeServices(httpx.Response(200, json=_generated()), SPOKEN)

    await _synthesizer(services).synthesize(
        "Hello", reference=REFERENCE, locale="en", api_key="dub-mkt"
    )

    (sent,) = services.syntheses
    assert sent.headers["Authorization"] == "Bearer dub-mkt"


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
        (httpx.Response(200, json={"request_id": "r", "output": {}}), "PROVIDER_MALFORMED"),
        (httpx.Response(200, json=_generated(url="not-a-url")), "PROVIDER_MALFORMED"),
        (httpx.ReadTimeout("等不到"), "PROVIDER_RESULT_UNKNOWN"),
        (httpx.ConnectError("连不上"), "PROVIDER_UNREACHABLE"),
    ],
    ids=["拒绝", "限流", "5xx", "不是 JSON", "没有音频", "地址不合法", "读超时", "连不上"],
)
async def test_service_failures_carry_a_code_that_tells_whether_it_was_received(
    response: httpx.Response | Exception, code: str
) -> None:
    services = FakeServices(response, SPOKEN)

    failure = await _synthesize_and_fail(services)

    assert failure.code == code
    assert services.downloads == [], "没拿到合格的回执就不去取音频"


@pytest.mark.parametrize("audio", [None, b""], ids=["refused", "empty"])
async def test_audio_that_cannot_be_downloaded_fails_without_its_address(
    audio: bytes | None,
) -> None:
    services = FakeServices(httpx.Response(200, json=_generated()), audio)

    failure = await _synthesize_and_fail(services)

    assert failure.code == "OUTPUT_DOWNLOAD_FAILED"
    assert not failure.retryable, "已经计费，不重新合成"
    assert "result.test" not in str(failure)
