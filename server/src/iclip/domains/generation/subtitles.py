"""字幕识别的适配器：千问录音文件识别的同步接口，模型固定为 ``qwen-audio-3.1-asr-flash``。

一次识别是一次同步调用：下载成片、抽成单声道 16 kHz mp3、以 Base64 Data URI 编进请求、等结果，
没有轮询阶段。开说话人分离才拿得到全部句子的起止时间（``output.sentences``），而说话人分离只收
单声道音频，所以先在本地抽音轨。没有音轨就是没有口播：不调接口，直接给空结果。

识别是付费调用，提交阶段的任何失败都不重投（不变量 10）：请求发出去却没拿到结果记
``PROVIDER_RESULT_UNKNOWN``。"""

from __future__ import annotations

import base64
from collections.abc import Callable, Mapping
from dataclasses import dataclass
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
from iclip.domains.generation.schemas import SubtitleRequest, SubtitleSentence
from iclip.platform.media.audio import SPEECH_SAMPLE_RATE, extract_speech_audio
from iclip.platform.media.errors import MediaError, NoAudioStream
from iclip.platform.media.fetch import MAX_VIDEO_BYTES, download

_logger = structlog.stdlib.get_logger(__name__)

PROVIDER_NAME: Final = "qwen_asr"

SUBTITLE_MODEL: Final = "qwen-audio-3.1-asr-flash"
"""识别用的模型，钉在代码里不进配置：请求参数与结果的解析都只按这个模型的接口写。"""

MAX_AUDIO_DATA_CHARS: Final = 10_000_000
"""Base64 Data URI 的长度上限：接口文档写明编码后的音频不能超过 10 MB。按 10^7 字符算，宁紧勿松；
固定码率下 5 分钟（模型的时长上限）编码后约 3.2 MB，远在线内。"""

_AUDIO_MIME: Final = "audio/mp3"


@dataclass(frozen=True, slots=True)
class SubtitleProviderSettings:
    """由组合根从配置与环境变量解析后传入的运行值。"""

    url: str
    """同步识别接口的完整地址（multimodal-generation 端点）。"""
    api_key: str
    timeout_seconds: float
    """一次识别请求等结果的上限。"""


class QwenSubtitleProvider:
    """``GenerationProvider`` 的字幕识别实现。同步出结果，``submit`` 直接带回逐句字幕。"""

    def __init__(
        self,
        settings: SubtitleProviderSettings,
        *,
        fetch_url: Callable[[str], str],
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        """``fetch_url`` 在下载成片前换算地址（本桶对象走内网），请求里记的地址不改；``transport``
        给下载与识别请求共用，测试替身从这里进。"""

        self._settings = settings
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
        """下载成片、抽成识别用的 mp3，返回字节；没有音轨返回 ``None``。临时目录在退出时清掉。"""

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
        """发一次识别请求，交回同步识别回执。

        连不上是 ``PROVIDER_UNREACHABLE``；连上了却没拿到结果（读超时之类）是
        ``PROVIDER_RESULT_UNKNOWN``：请求可能已被收下、已计费。明确的空口播返回空结果；其余
        5xx、4xx、响应不是 JSON 对象各有错误码；都发生在提交阶段，一律不重投。"""

        try:
            async with httpx.AsyncClient(
                timeout=self._settings.timeout_seconds, transport=self._transport
            ) as client:
                response = await client.post(
                    self._settings.url,
                    json=payload,
                    headers={
                        "Authorization": f"Bearer {self._settings.api_key}",
                        # 只要最终结果，不要 SSE 流式返回。
                        "X-DashScope-SSE": "disable",
                    },
                )
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            raise ProviderError(
                f"字幕识别接口连不上: {exc}", code="PROVIDER_UNREACHABLE", retryable=True
            ) from exc
        except httpx.HTTPError as exc:
            raise ProviderError(
                f"字幕识别请求已发出但没拿到结果，不重试以免重复计费: {exc}",
                code="PROVIDER_RESULT_UNKNOWN",
                retryable=False,
            ) from exc
        if response.status_code >= 500:
            raise ProviderError(
                f"字幕识别接口返回 {response.status_code}: {response.text[:500]}",
                code="PROVIDER_SERVER_ERROR",
                retryable=True,
            )
        if response.status_code == 400:
            try:
                body = response.json()
            except ValueError:
                body = None
            if (
                isinstance(body, dict)
                and body.get("code") == "CLIENT_ERROR"
                and body.get("message") == "ASR_RESPONSE_HAVE_NO_WORDS"
            ):
                return ProviderSubmission(
                    provider_task_id=_request_id(body),
                    provider_status="ASR_RESPONSE_HAVE_NO_WORDS",
                    sentences=(),
                )
        if response.status_code >= 400:
            raise ProviderError(
                f"字幕识别接口拒绝了这次请求（{response.status_code}）: {response.text[:500]}",
                code="PROVIDER_REJECTED",
                retryable=False,
            )
        try:
            body = response.json()
        except ValueError as exc:
            raise ProviderError(
                "字幕识别接口的响应不是 JSON", code="PROVIDER_MALFORMED", retryable=False
            ) from exc
        if not isinstance(body, dict):
            raise ProviderError(
                "字幕识别接口的响应根不是 object", code="PROVIDER_MALFORMED", retryable=False
            )
        return ProviderSubmission(
            provider_task_id=_request_id(body),
            provider_status="succeeded",
            sentences=sentences_from_response(body),
        )


def _request_id(body: Mapping[str, Any]) -> str:
    request_id = body.get("request_id")
    if not isinstance(request_id, str) or not request_id.strip():
        raise _malformed("识别响应里的 request_id 必须是非空字符串")
    return request_id


def _payload(request: SubtitleRequest, data: str) -> dict[str, Any]:
    """识别请求体：音频放在用户消息的 ``input_audio`` 里，参数照记录里的请求。"""

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
    """把识别响应的 ``output.sentences`` 映射成逐句字幕，按响应里的先后。

    ``sentences`` 是空数组就是没有口播，给空元组。每句取 ``begin_time`` / ``end_time``（毫秒）、
    ``text`` 与 ``speaker_id``（可以是 null）；没有 ``output``、``sentences`` 缺失或不是数组、哪一句
    的字段缺了或类型不对，抛 ``PROVIDER_MALFORMED``，不猜。"""

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
    """JSON 里的整数；``True`` / ``False`` 在 Python 里也是 int，不算。"""

    return isinstance(value, int) and not isinstance(value, bool)


def _malformed(message: str) -> ProviderError:
    return ProviderError(message, code="PROVIDER_MALFORMED", retryable=False)


__all__ = [
    "MAX_AUDIO_DATA_CHARS",
    "PROVIDER_NAME",
    "SUBTITLE_MODEL",
    "QwenSubtitleProvider",
    "SubtitleProviderSettings",
    "sentences_from_response",
]
