"""千问音频生成给的 wav 地址带签名、24 小时后失效，所以下载规整后转存进自己的桶。"""

from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Final

import httpx
from agent_runtime.urls import is_http_url

from iclip.domains.generation.models import GenerationJob
from iclip.domains.generation.provider import (
    ProviderError,
    ProviderProgress,
    ProviderSubmission,
    request_of,
)
from iclip.domains.generation.qwen import QwenEndpoint, post_to_qwen, request_id_of
from iclip.domains.generation.schemas import MusicRequest
from iclip.platform.media.audio import normalize_music
from iclip.platform.media.errors import MediaError
from iclip.platform.media.fetch import MAX_AUDIO_BYTES, download
from iclip.platform.object_store.layout import MEDIA_PATHS
from iclip.platform.object_store.store import ObjectStoreUnavailable, PublicObjectStore

PROVIDER_NAME: Final = "qwen_music"

MUSIC_MODEL: Final = "qwen-audio-3.1-tts-next"

_EXT: Final = "m4a"
_CONTENT_TYPE: Final = "audio/mp4"

_LABEL: Final = "音乐生成"


class QwenMusicProvider:
    def __init__(
        self,
        endpoint: QwenEndpoint,
        *,
        object_store: PublicObjectStore,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._endpoint = endpoint
        self._object_store = object_store
        self._transport = transport

    @property
    def name(self) -> str:
        return PROVIDER_NAME

    async def submit(self, job: GenerationJob) -> ProviderSubmission:
        request = request_of(job, MusicRequest, provider=PROVIDER_NAME)
        body = await post_to_qwen(
            self._endpoint, _payload(request), label=_LABEL, transport=self._transport
        )
        request_id = request_id_of(body, label=_LABEL)
        content, duration_ms = await self._normalized(_generated_url(body))
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
        return ProviderSubmission(
            provider_task_id=request_id,
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

    async def _normalized(self, generated_url: str) -> tuple[bytes, int]:
        with TemporaryDirectory(prefix="iclip-music-") as tmp:
            root = Path(tmp)
            source = root / "generated.wav"
            dest = root / f"music.{_EXT}"
            try:
                async with httpx.AsyncClient(transport=self._transport) as client:
                    await download(client, generated_url, source, max_bytes=MAX_AUDIO_BYTES)
            except MediaError as exc:
                # 模型给的地址带签名，不进会落库给人看的错误信息。
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


__all__ = ["MUSIC_MODEL", "PROVIDER_NAME", "QwenMusicProvider"]
