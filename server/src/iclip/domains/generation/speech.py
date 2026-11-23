"""配音逐句合成：调用千问 AI 平台音频生成接口，基于参考音色将单句台词合成为语音。"""

from __future__ import annotations

import base64
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

# 与截取的参考音频保持相同规格，便于后续解码、对齐与音轨拼接。
SPEECH_FORMAT: Final = "wav"
SPEECH_SAMPLE_RATE: Final = 48_000
SPEECH_CHANNELS: Final = 1

_LABEL: Final = "配音合成"


class QwenSpeechSynthesizer:
    """``SpeechSynthesizer`` 实现：按句发起合成请求，参考音频以 data URI 随请求携带并在提示词中通过
    ``@voice1`` 引用（指定语种时显式声明目标语言），随后下载模型返回的临时音频。"""

    def __init__(
        self, endpoint: QwenEndpoint, *, transport: httpx.AsyncBaseTransport | None = None
    ) -> None:
        self._endpoint = endpoint
        self._transport = transport

    async def synthesize(
        self, text: str, *, reference: bytes, locale: TargetLocale | None, api_key: str
    ) -> bytes:
        body = await post_to_qwen(
            self._endpoint,
            _payload(text, reference=reference, locale=locale),
            api_key=api_key,
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
                # MediaError 正文可能包含模型返回的签名地址，此处仅提取底层异常类型名。
                cause = type(exc.__cause__).__name__ if exc.__cause__ is not None else "内容不合格"
                raise ProviderError(
                    f"配音已合成但下载失败（{cause}），不重新合成以免重复计费",
                    code="OUTPUT_DOWNLOAD_FAILED",
                    retryable=False,
                ) from exc
            return dest.read_bytes()


def _payload(text: str, *, reference: bytes, locale: TargetLocale | None) -> dict[str, Any]:
    voice = base64.b64encode(reference).decode("ascii")
    language = "" if locale is None else f"用{LANGUAGE_NAMES[locale]}"
    return {
        "model": SPEECH_MODEL,
        "input": {
            "text_prompt": f"@voice1 {language}说：“{text}”",
            "references": [{"audio_data": f"data:audio/wav;base64,{voice}"}],
            "format": SPEECH_FORMAT,
            "sample_rate": SPEECH_SAMPLE_RATE,
            "channels": SPEECH_CHANNELS,
        },
    }


__all__ = ["SPEECH_MODEL", "QwenSpeechSynthesizer"]
