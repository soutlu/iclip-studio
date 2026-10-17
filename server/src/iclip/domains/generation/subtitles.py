"""千问录音文件识别：开说话人分离才拿得到全部句子的起止时间（``output.sentences``），而说话人分离只收
单声道音频，所以先在本地把成片抽成单声道 mp3。"""

from __future__ import annotations

import base64
from collections.abc import Callable, Mapping
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Final, TypeIs

import httpx
import structlog

from iclip.domains.generation.models import GenerationJob
from iclip.domains.generation.provider import (
    ProviderError,
    ProviderProgress,
    ProviderSubmission,
    request_of,
)
from iclip.domains.generation.qwen import QwenEndpoint, post_to_qwen, request_id_of
from iclip.domains.generation.schemas import SubtitleRequest, SubtitleSentence
from iclip.domains.generation.upstream import UpstreamRejected
from iclip.platform.media.audio import SPEECH_SAMPLE_RATE, extract_speech_audio
from iclip.platform.media.errors import MediaError, NoAudioStream
from iclip.platform.media.fetch import MAX_VIDEO_BYTES, download

_logger = structlog.stdlib.get_logger(__name__)

PROVIDER_NAME: Final = "qwen_asr"

SUBTITLE_MODEL: Final = "qwen-audio-3.1-asr-flash"

# 接口文档写明编码后的音频不能超过 10 MB，按 10^7 字符算。
MAX_AUDIO_DATA_CHARS: Final = 10_000_000

_AUDIO_MIME: Final = "audio/mp3"

_LABEL: Final = "字幕识别"


class QwenSubtitleProvider:
    def __init__(
        self,
        endpoint: QwenEndpoint,
        *,
        fetch_url: Callable[[str], str],
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._endpoint = endpoint
        self._fetch_url = fetch_url
        self._transport = transport

    @property
    def name(self) -> str:
        return PROVIDER_NAME

    async def submit(self, job: GenerationJob) -> ProviderSubmission:
        request = request_of(job, SubtitleRequest, provider=PROVIDER_NAME)
        audio = await self._speech_audio(request.video_url)
        if audio is None:
            _logger.info("成片没有音轨，字幕记为没有口播", job_id=job.id)
            return ProviderSubmission(
                provider_task_id=str(job.id), provider_status="no_audio", sentences=()
            )
        data = f"data:{_AUDIO_MIME};base64,{base64.b64encode(audio).decode('ascii')}"
        if len(data) > MAX_AUDIO_DATA_CHARS:
            raise ProviderError(
                f"抽出的音频编码后有 {len(data)} 字符，超过识别接口 {MAX_AUDIO_DATA_CHARS} 的上限",
                code="SUBTITLE_AUDIO_TOO_LARGE",
                retryable=False,
            )
        return await self._recognize(_payload(request, data))

    async def poll(self, job: GenerationJob) -> ProviderProgress:
        raise ProviderError(
            "字幕识别是同步的，没有轮询阶段",
            code="PROVIDER_POLL_UNSUPPORTED",
            retryable=False,
        )

    async def _speech_audio(self, video_url: str) -> bytes | None:
        with TemporaryDirectory(prefix="iclip-subtitle-") as tmp:
            root = Path(tmp)
            source = root / "source.mp4"
            dest = root / "speech.mp3"
            try:
                async with httpx.AsyncClient(transport=self._transport) as client:
                    await download(
                        client, self._fetch_url(video_url), source, max_bytes=MAX_VIDEO_BYTES
                    )
            except MediaError as exc:
                raise ProviderError(
                    f"取不到要识别的视频: {exc}",
                    code="MEDIA_SOURCE_UNREACHABLE",
                    retryable=False,
                ) from exc
            try:
                await extract_speech_audio(source, dest=dest)
            except NoAudioStream:
                return None
            except MediaError as exc:
                raise ProviderError(
                    f"从视频里抽音频失败: {exc}", code="MEDIA_PROCESS_FAILED", retryable=False
                ) from exc
            return dest.read_bytes()

    async def _recognize(self, payload: dict[str, Any]) -> ProviderSubmission:
        try:
            body = await post_to_qwen(
                self._endpoint,
                payload,
                label=_LABEL,
                transport=self._transport,
                # 只要最终结果，不要 SSE 流式返回。
                headers={"X-DashScope-SSE": "disable"},
            )
        except UpstreamRejected as exc:
            if exc.status_code == 400 and _is_no_words(exc.body):
                return ProviderSubmission(
                    provider_task_id=request_id_of(exc.body, label=_LABEL),
                    provider_status="ASR_RESPONSE_HAVE_NO_WORDS",
                    sentences=(),
                )
            raise
        return ProviderSubmission(
            provider_task_id=request_id_of(body, label=_LABEL),
            provider_status="succeeded",
            sentences=sentences_from_response(body),
        )


def _is_no_words(body: object) -> TypeIs[dict[str, Any]]:
    # 识别出来一句都没有时，接口答 400 而不是空的 sentences。
    return (
        isinstance(body, dict)
        and body.get("code") == "CLIENT_ERROR"
        and body.get("message") == "ASR_RESPONSE_HAVE_NO_WORDS"
    )


def _payload(request: SubtitleRequest, data: str) -> dict[str, Any]:
    return {
        "model": request.model,
        "input": {
            "messages": [
                {
                    "role": "user",
                    "content": [{"type": "input_audio", "input_audio": {"data": data}}],
                }
            ]
        },
        "parameters": {
            "format": request.audio_format,
            "sample_rate": str(SPEECH_SAMPLE_RATE),
            "speaker_diarization_enabled": request.speaker_diarization,
        },
    }


def sentences_from_response(body: Mapping[str, Any]) -> tuple[SubtitleSentence, ...]:
    output = body.get("output")
    if not isinstance(output, dict):
        raise _malformed("识别响应里没有 output 对象")
    raw = output.get("sentences")
    if not isinstance(raw, list):
        raise _malformed("识别响应的 output.sentences 不是数组")
    sentences: list[SubtitleSentence] = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise _malformed(f"output.sentences[{index}] 不是对象")
        start: object = item.get("begin_time")
        end: object = item.get("end_time")
        text: object = item.get("text")
        speaker: object = item.get("speaker_id")
        if not _is_int(start) or not _is_int(end) or not isinstance(text, str):
            raise _malformed(f"output.sentences[{index}] 缺 begin_time / end_time / text")
        if speaker is not None and not _is_int(speaker):
            raise _malformed(f"output.sentences[{index}].speaker_id 不是整数")
        try:
            sentences.append(
                SubtitleSentence(start_ms=start, end_ms=end, text=text, speaker=speaker)
            )
        except ValueError as exc:
            raise _malformed(f"output.sentences[{index}] 的时间不合法: {exc}") from exc
    return tuple(sentences)


def _is_int(value: object) -> TypeIs[int]:
    return isinstance(value, int) and not isinstance(value, bool)


def _malformed(message: str) -> ProviderError:
    return ProviderError(message, code="PROVIDER_MALFORMED", retryable=False)


__all__ = [
    "MAX_AUDIO_DATA_CHARS",
    "PROVIDER_NAME",
    "SUBTITLE_MODEL",
    "QwenSubtitleProvider",
    "sentences_from_response",
]
