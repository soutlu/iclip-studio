"""生成背景音乐的适配器：千问AI平台的音频生成同步接口，模型固定为 ``qwen-audio-3.1-tts-next``。

一次生成是一次同步调用：提示词原样作为 ``text_prompt`` 发出，等结果，没有轮询阶段。模型给的是
24 小时后失效的 wav 地址，执行方下载下来、去掉首尾静音、统一响度、编成 m4a，转存成本系统的公开
对象，记下量出来的时长；转存或规整不成功这次生成就是失败，不留模型给的地址。

生成是付费调用，提交阶段的任何失败都不重投（不变量 10）：请求发出去却没拿到结果记
``PROVIDER_RESULT_UNKNOWN``；已经生成、之后下载、规整或转存失败也不重新生成。"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Final

import httpx

from iclip.common.urls import is_http_url
from iclip.domains.generation.models import GenerationJob
from iclip.domains.generation.provider import (
    ProviderError,
    ProviderProgress,
    ProviderSubmission,
    request_of,
)
from iclip.domains.generation.schemas import MusicRequest
from iclip.platform.media.ffmpeg import MAX_AUDIO_BYTES, MediaError, download, normalize_music
from iclip.platform.object_store.layout import MEDIA_PATHS
from iclip.platform.object_store.store import ObjectStoreUnavailable, PublicObjectStore

PROVIDER_NAME: Final = "qwen_music"

MUSIC_MODEL: Final = "qwen-audio-3.1-tts-next"
"""生成背景音乐用的模型，钉在代码里不进配置：请求体与结果的解析都只按这个模型的接口写。"""

_EXT: Final = "m4a"
_CONTENT_TYPE: Final = "audio/mp4"


@dataclass(frozen=True, slots=True)
class MusicProviderSettings:
    """由组合根从配置与环境变量解析后传入的运行值。"""

    url: str
    """音频生成同步接口的完整地址（``…/api/v1/services/audio/tts/SpeechSynthesizer``）。"""
    api_key: str
    timeout_seconds: float
    """一次生成请求等结果的上限。"""


class QwenMusicProvider:
    """``GenerationProvider`` 的背景音乐实现。同步出结果，``submit`` 直接带回转存后的地址与时长。"""

    def __init__(
        self,
        settings: MusicProviderSettings,
        *,
        object_store: PublicObjectStore,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        """``transport`` 给生成请求与下载结果共用，测试替身从这里进。"""

        self._settings = settings
        self._object_store = object_store
        self._transport = transport

    @property
    def name(self) -> str:
        return PROVIDER_NAME

    async def submit(self, job: GenerationJob) -> ProviderSubmission:
        request = request_of(job, MusicRequest, provider=PROVIDER_NAME)
        body = await self._generate(_payload(request))
        generated = _generated_url(body)
        content, duration_ms = await self._normalized(generated)
        try:
            stored = await self._object_store.put_public_object(
                object_key=MEDIA_PATHS.generated_music(job_id=job.id, ext=_EXT),
                content=content,
                content_type=_CONTENT_TYPE,
            )
        except ObjectStoreUnavailable as exc:
            raise ProviderError(
                f"音乐已生成但存不进桶: {exc}", code="OUTPUT_STORE_FAILED", retryable=False
            ) from exc
        request_id = body.get("request_id")
        return ProviderSubmission(
            provider_task_id=request_id
            if isinstance(request_id, str) and request_id
            else str(job.id),
            provider_status="succeeded",
            output_url=stored,
            duration_ms=duration_ms,
        )

    async def poll(self, job: GenerationJob) -> ProviderProgress:
        raise ProviderError(
            "生成背景音乐是同步的，没有轮询阶段",
            code="PROVIDER_POLL_UNSUPPORTED",
            retryable=False,
        )

    async def _generate(self, payload: dict[str, Any]) -> dict[str, Any]:
        """发一次生成请求，交回 JSON 对象。

        连不上是 ``PROVIDER_UNREACHABLE``；连上了却没拿到结果（读超时之类）是
        ``PROVIDER_RESULT_UNKNOWN``：请求可能已被收下、已计费。5xx、4xx、响应不是 JSON 对象各有
        错误码；都发生在提交阶段，一律不重投。"""

        try:
            async with httpx.AsyncClient(
                timeout=self._settings.timeout_seconds, transport=self._transport
            ) as client:
                response = await client.post(
                    self._settings.url,
                    json=payload,
                    headers={"Authorization": f"Bearer {self._settings.api_key}"},
                )
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            raise ProviderError(
                f"音乐生成接口连不上: {exc}", code="PROVIDER_UNREACHABLE", retryable=True
            ) from exc
        except httpx.HTTPError as exc:
            raise ProviderError(
                f"音乐生成请求已发出但没拿到结果，不重试以免重复计费: {exc}",
                code="PROVIDER_RESULT_UNKNOWN",
                retryable=False,
            ) from exc
        if response.status_code >= 500:
            raise ProviderError(
                f"音乐生成接口返回 {response.status_code}: {response.text[:500]}",
                code="PROVIDER_SERVER_ERROR",
                retryable=True,
            )
        if response.status_code >= 400:
            raise ProviderError(
                f"音乐生成接口拒绝了这次请求（{response.status_code}）: {response.text[:500]}",
                code="PROVIDER_REJECTED",
                retryable=False,
            )
        try:
            body = response.json()
        except ValueError as exc:
            raise ProviderError(
                "音乐生成接口的响应不是 JSON", code="PROVIDER_MALFORMED", retryable=False
            ) from exc
        if not isinstance(body, dict):
            raise ProviderError(
                "音乐生成接口的响应根不是 object", code="PROVIDER_MALFORMED", retryable=False
            )
        return body

    async def _normalized(self, generated_url: str) -> tuple[bytes, int]:
        """下载模型给的音频、规整成背景音乐，交回产物字节与量出来的时长（毫秒）。临时目录在退出时
        清掉。

        模型给的地址带签名、24 小时后失效，不写进错误信息：错误信息会落库、给人看。"""

        with TemporaryDirectory(prefix="iclip-music-") as tmp:
            root = Path(tmp)
            source = root / "generated.wav"
            dest = root / f"music.{_EXT}"
            try:
                async with httpx.AsyncClient(transport=self._transport) as client:
                    await download(client, generated_url, source, max_bytes=MAX_AUDIO_BYTES)
            except MediaError as exc:
                cause = type(exc.__cause__).__name__ if exc.__cause__ is not None else "内容不合格"
                raise ProviderError(
                    f"音乐已生成但下载不下来（{cause}），不重新生成以免重复计费",
                    code="OUTPUT_DOWNLOAD_FAILED",
                    retryable=False,
                ) from exc
            try:
                duration_ms = await normalize_music(source, dest=dest)
            except MediaError as exc:
                raise ProviderError(
                    f"音乐已生成但规整失败: {exc}", code="MEDIA_PROCESS_FAILED", retryable=False
                ) from exc
            return dest.read_bytes(), duration_ms


def _payload(request: MusicRequest) -> dict[str, Any]:
    """生成请求体：提示词原样作为 ``text_prompt``，音频格式照记录里的请求。"""

    return {
        "model": request.model,
        "input": {
            "text_prompt": request.prompt,
            "format": request.format,
            "sample_rate": request.sample_rate,
            "channels": request.channels,
        },
    }


def _generated_url(body: dict[str, Any]) -> str:
    """响应里 ``output.audio.url`` 的地址；没有或不是 http(s) 地址抛 ``PROVIDER_MALFORMED``。"""

    output = body.get("output")
    audio = output.get("audio") if isinstance(output, dict) else None
    url = audio.get("url") if isinstance(audio, dict) else None
    if not isinstance(url, str) or not is_http_url(url):
        raise ProviderError(
            "音乐生成接口的响应里没有音频地址（output.audio.url）",
            code="PROVIDER_MALFORMED",
            retryable=False,
        )
    return url


__all__ = ["MUSIC_MODEL", "PROVIDER_NAME", "MusicProviderSettings", "QwenMusicProvider"]
