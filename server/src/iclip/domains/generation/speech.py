"""配音的逐句合成：千问AI平台的音频生成接口，用参考音频的声音把一句话念出来。"""

from __future__ import annotations

import base64
from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Final

import httpx

from iclip.common.final_cut import LANGUAGE_NAMES, TargetLocale
from iclip.domains.generation.provider import ProviderError
from iclip.domains.generation.qwen import QwenEndpoint, audio_url_of, post_to_qwen
from iclip.platform.media.errors import MediaError
from iclip.platform.media.fetch import MAX_AUDIO_BYTES, download

SPEECH_MODEL: Final = "qwen-audio-3.1-tts-next"

# 和截出来的参考音频同一个规格，后面解码、对齐、拼音轨都按这个处理。
SPEECH_FORMAT: Final = "wav"
SPEECH_SAMPLE_RATE: Final = 48_000
SPEECH_CHANNELS: Final = 1

_LABEL: Final = "配音合成"


class QwenSpeechSynthesizer:
    """``SpeechSynthesizer`` 的实现：每句发一次请求，参考音频以 data URI 随请求带上，提示词里用
    ``@voice1`` 引用它并写明用哪种语言念；再把模型给的临时地址上的音频取回来。"""

    def __init__(
        self, endpoint: QwenEndpoint, *, transport: httpx.AsyncBaseTransport | None = None
    ) -> None:
        self._endpoint = endpoint
        self._transport = transport

    async def synthesize(
        self, text: str, *, reference: bytes, locale: TargetLocale, api_key: str | None
    ) -> bytes:
        endpoint = self._endpoint if api_key is None else replace(self._endpoint, api_key=api_key)
        body = await post_to_qwen(
            endpoint,
            _payload(text, reference=reference, locale=locale),
            label=_LABEL,
            transport=self._transport,
        )
        return await self._downloaded(audio_url_of(body, label=_LABEL))

    async def _downloaded(self, generated_url: str) -> bytes:
        with TemporaryDirectory(prefix="iclip-speech-") as tmp:
            dest = Path(tmp) / f"speech.{SPEECH_FORMAT}"
            try:
                async with httpx.AsyncClient(transport=self._transport) as client:
                    await download(client, generated_url, dest, max_bytes=MAX_AUDIO_BYTES)
            except MediaError as exc:
                # MediaError 的正文带着模型给的签名地址，只取原因的类型名。
                cause = type(exc.__cause__).__name__ if exc.__cause__ is not None else "内容不合格"
                raise ProviderError(
                    f"配音已合成但下载不下来（{cause}），不重新合成以免重复计费",
                    code="OUTPUT_DOWNLOAD_FAILED",
                    retryable=False,
                ) from exc
            return dest.read_bytes()


def _payload(text: str, *, reference: bytes, locale: TargetLocale) -> dict[str, Any]:
    voice = base64.b64encode(reference).decode("ascii")
    return {
        "model": SPEECH_MODEL,
        "input": {
            "text_prompt": f"@voice1 用{LANGUAGE_NAMES[locale]}说：“{text}”",
            "references": [{"audio_data": f"data:audio/wav;base64,{voice}"}],
            "format": SPEECH_FORMAT,
            "sample_rate": SPEECH_SAMPLE_RATE,
            "channels": SPEECH_CHANNELS,
        },
    }


__all__ = ["SPEECH_MODEL", "QwenSpeechSynthesizer"]
