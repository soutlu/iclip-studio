"""网关的生成接口没有幂等键：提交阶段不自动重试、不切换渠道，以免重复计费或改变调用方选择的价格。"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Final
from urllib.parse import urlsplit

import httpx

from iclip.common.urls import is_http_url
from iclip.domains.generation.models import GenerationJob
from iclip.domains.generation.provider import (
    ImageModelSpec,
    ProviderError,
    ProviderProgress,
    ProviderSubmission,
    request_of,
    user_name_of,
)
from iclip.domains.generation.schemas import ImageGenerationIn
from iclip.domains.generation.upstream import post_json
from iclip.platform.media.fetch import MAX_IMAGE_BYTES
from iclip.platform.object_store.layout import MEDIA_PATHS
from iclip.platform.object_store.store import ObjectStoreUnavailable, PublicObjectStore

_DOWNLOAD_TIMEOUT_SECONDS: Final = 60.0

# 网关按它认调用方，取值须在它的来源白名单里。
TASK_SOURCE: Final = "iclip_agent"

_MIME_BY_SUFFIX: Final = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "webp": "image/webp",
}
_SUFFIX_BY_MIME: Final = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
}
_DEFAULT_MIME: Final = "image/png"

ImageFields = Callable[[ImageGenerationIn], dict[str, Any]]


@dataclass(frozen=True, slots=True)
class GatewayImageModel:
    name: str
    spec: ImageModelSpec
    timeout_seconds: float
    fields: ImageFields


@dataclass(frozen=True, slots=True)
class GatewayImageSettings:
    api_base: str
    env: str
    text_to_image_task: str
    image_edit_task: str


class GatewayImageProvider:
    def __init__(
        self,
        model: GatewayImageModel,
        settings: GatewayImageSettings,
        *,
        object_store: PublicObjectStore,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:

        self._model = model
        self._settings = settings
        self._object_store = object_store
        self._transport = transport

    @property
    def name(self) -> str:
        return self._model.name

    async def submit(self, job: GenerationJob) -> ProviderSubmission:
        request = request_of(job, ImageGenerationIn, provider=self.name)
        fields = self._model.fields(request)
        references = list(request.reference_image_urls)
        payload: dict[str, Any] = {
            "data_id": str(job.id),
            "user_name": user_name_of(request),
            "prompt": request.prompt,
            "task_source": TASK_SOURCE,
            "env": self._settings.env,
            **fields,
        }
        if references:
            payload["input_str_list"] = references
        body = await post_json(
            task_url(self._settings, editing=bool(references)),
            payload,
            label="图像生成",
            timeout=self._model.timeout_seconds,
            transport=self._transport,
        )
        source_url = _read_output_url(body)
        output_url = await _store_result(
            job_id=job.id,
            source_url=source_url,
            object_store=self._object_store,
            transport=self._transport,
        )
        return ProviderSubmission(
            # 网关不返回任务 id，使用请求 data_id 对账。
            provider_task_id=str(job.id),
            provider_status="succeeded",
            output_url=output_url,
        )

    async def poll(self, job: GenerationJob) -> ProviderProgress:
        raise ProviderError(
            "图像生成是同步的，没有轮询阶段",
            code="PROVIDER_POLL_UNSUPPORTED",
            retryable=False,
        )


def task_url(settings: GatewayImageSettings, *, editing: bool) -> str:
    task = settings.image_edit_task if editing else settings.text_to_image_task
    return f"{settings.api_base.rstrip('/')}/{task}"


def _read_output_url(body: dict[str, Any]) -> str:
    if body.get("success") is False:
        message = body.get("message")
        detail = message.strip() if isinstance(message, str) and message.strip() else "无说明"
        raise ProviderError(
            f"图像 provider 报告生成失败: {detail}",
            code="PROVIDER_GENERATION_FAILED",
            retryable=False,
        )
    for key in ("output_sign_str", "output_str"):
        value = body.get(key)
        if isinstance(value, str) and is_http_url(value):
            return value
    raise ProviderError(
        "图像 provider 的响应里没有结果 URL",
        code="PROVIDER_OUTPUT_MISSING",
        retryable=False,
    )


async def _store_result(
    *,
    job_id: uuid.UUID,
    source_url: str,
    object_store: PublicObjectStore,
    transport: httpx.AsyncBaseTransport | None,
) -> str:
    content, mime = await _download(source_url, transport=transport)
    try:
        return await object_store.put_public_object(
            object_key=MEDIA_PATHS.generated_image(job_id=job_id, ext=_SUFFIX_BY_MIME[mime]),
            content=content,
            content_type=mime,
        )
    except ObjectStoreUnavailable as exc:
        raise ProviderError(
            f"图像已生成但转存失败: {exc}",
            code="OUTPUT_STORE_FAILED",
            retryable=False,
        ) from exc


async def _download(url: str, *, transport: httpx.AsyncBaseTransport | None) -> tuple[bytes, str]:
    try:
        async with (
            httpx.AsyncClient(timeout=_DOWNLOAD_TIMEOUT_SECONDS, transport=transport) as client,
            client.stream("GET", url) as response,
        ):
            if response.status_code >= 400:
                raise ProviderError(
                    f"结果图下载失败（{response.status_code}）",
                    code="OUTPUT_DOWNLOAD_FAILED",
                    retryable=False,
                )
            mime = _normalize_mime(response.headers.get("content-type", ""), url)
            chunks: list[bytes] = []
            size = 0
            async for chunk in response.aiter_bytes():
                size += len(chunk)
                if size > MAX_IMAGE_BYTES:
                    raise ProviderError(
                        f"结果图超过 {MAX_IMAGE_BYTES} 字节上限",
                        code="OUTPUT_TOO_LARGE",
                        retryable=False,
                    )
                chunks.append(chunk)
    except httpx.HTTPError as exc:
        raise ProviderError(
            f"结果图下载失败: {exc}",
            code="OUTPUT_DOWNLOAD_FAILED",
            retryable=False,
        ) from exc
    content = b"".join(chunks)
    if not content:
        raise ProviderError(
            "结果图下载为空",
            code="OUTPUT_DOWNLOAD_EMPTY",
            retryable=False,
        )
    return content, mime


def _normalize_mime(content_type: str, url: str) -> str:
    mime = content_type.split(";", maxsplit=1)[0].strip().lower()
    if mime in _SUFFIX_BY_MIME:
        return mime
    path = urlsplit(url).path.lower()
    for suffix, known in _MIME_BY_SUFFIX.items():
        if path.endswith(f".{suffix}"):
            return known
    return _DEFAULT_MIME


__all__ = [
    "TASK_SOURCE",
    "GatewayImageModel",
    "GatewayImageProvider",
    "GatewayImageSettings",
    "ImageFields",
    "task_url",
]
