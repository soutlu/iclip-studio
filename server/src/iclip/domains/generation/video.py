from __future__ import annotations

import math
import uuid
from dataclasses import dataclass
from typing import Any, Final
from urllib.parse import quote

import httpx
import structlog

from iclip.common.urls import is_http_url
from iclip.domains.generation.model_groups import ModelGroups
from iclip.domains.generation.models import GenerationJob
from iclip.domains.generation.provider import (
    ProviderError,
    ProviderProgress,
    ProviderSubmission,
    request_of,
    user_name_of,
)
from iclip.domains.generation.schemas import (
    DRAFT_TASK_FIELD,
    NOT_FORWARDED_FIELDS,
    VideoEnhanceRequest,
    VideoGenerationIn,
)

PROVIDER_NAME: Final = "video_api"

_REQUESTS: Final = (VideoGenerationIn, VideoEnhanceRequest)

# 转 1080p 入口只收这三个键，多一个（包括 model）就 400，模型由上游沿用样片的。
_DRAFT_COMPLETE_FIELDS: Final = frozenset({DRAFT_TASK_FIELD, "resolution", "user_name"})

_logger = structlog.stdlib.get_logger(__name__)

_RUNNING_STATUSES: Final = frozenset({"queued", "pending", "running", "processing"})
_SUCCEEDED_STATUS: Final = "succeeded"
_FAILED_STATUSES: Final = frozenset({"failed", "cancelled", "canceled", "error", "timeout"})

_SUBMIT_TIMEOUT_SECONDS: Final = 30.0
_POLL_TIMEOUT_SECONDS: Final = 20.0
_MAX_DURATION_MS: Final = 2**31 - 1


@dataclass(frozen=True, slots=True)
class VideoProviderSettings:
    submit_url: str
    status_base_url: str
    enhance_submit_url: str | None = None
    draft_complete_url: str | None = None


class HttpVideoProvider:
    def __init__(
        self,
        settings: VideoProviderSettings,
        *,
        model_groups: ModelGroups,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._settings = settings
        self._model_groups = model_groups
        self._transport = transport

    @property
    def name(self) -> str:
        return PROVIDER_NAME

    async def submit(self, job: GenerationJob) -> ProviderSubmission:
        request = request_of(job, _REQUESTS, provider=PROVIDER_NAME)
        user_name_of(request)
        group = self._model_groups.of(job)
        upstream_model = job.upstream_model
        if upstream_model is None and job.model_group is not None:
            raise ProviderError(
                f"配置组 {group.name} 的生成记录缺少视频网关 model_id",
                code="MODEL_GROUP_UPSTREAM_MODEL_MISSING",
                retryable=False,
            )
        if isinstance(request, VideoEnhanceRequest):
            if self._settings.enhance_submit_url is None:
                raise ProviderError(
                    "高清版（超分）功能未启用，缺少超分提交地址",
                    code="ENHANCE_NOT_CONFIGURED",
                    retryable=False,
                )
            url = self._settings.enhance_submit_url
            payload = _with_model(request.model_dump(exclude_none=True), upstream_model)
        elif request.draft_task_id is not None:
            if self._settings.draft_complete_url is None:
                raise ProviderError(
                    "样片转 1080p 功能未启用，缺少转 1080p 提交地址",
                    code="DRAFT_COMPLETE_NOT_CONFIGURED",
                    retryable=False,
                )
            url = self._settings.draft_complete_url
            payload = request.model_dump(include=set(_DRAFT_COMPLETE_FIELDS))
        else:
            url = self._settings.submit_url
            payload = _with_model(
                request.model_dump(exclude_none=True, exclude=set(NOT_FORWARDED_FIELDS)),
                upstream_model,
            )
        body = await self._request(
            "POST",
            url,
            api_key=group.video_api_key,
            json=payload,
            timeout=_SUBMIT_TIMEOUT_SECONDS,
            result_unknown_on_transport_error=True,
        )
        task_id = body.get("task_id")
        if not isinstance(task_id, str) or not task_id.strip():
            raise ProviderError(
                "视频提交响应里没有 task_id",
                code="PROVIDER_SUBMIT_MALFORMED",
                retryable=False,
            )
        return ProviderSubmission(provider_task_id=task_id.strip(), provider_status="queued")

    async def poll(self, job: GenerationJob) -> ProviderProgress:
        request = request_of(job, _REQUESTS, provider=PROVIDER_NAME)
        task_id = job.provider_task_id
        if task_id is None:
            raise ProviderError(
                "还没有 provider 任务 id，无从查询",
                code="PROVIDER_TASK_ID_MISSING",
                retryable=False,
            )
        url = f"{self._settings.status_base_url.rstrip('/')}/{quote(task_id, safe='')}"
        body = await self._request(
            "GET",
            url,
            api_key=self._model_groups.of(job).video_api_key,
            params={"user_name": user_name_of(request)},
            timeout=_POLL_TIMEOUT_SECONDS,
        )
        return _progress_from_body(body, job_id=job.id, task_id=task_id)

    async def _request(
        self,
        method: str,
        url: str,
        *,
        api_key: str,
        timeout: float,
        json: dict[str, Any] | None = None,
        params: dict[str, str] | None = None,
        result_unknown_on_transport_error: bool = False,
    ) -> dict[str, Any]:
        try:
            async with httpx.AsyncClient(timeout=timeout, transport=self._transport) as client:
                response = await client.request(
                    method,
                    url,
                    json=json,
                    params=params,
                    headers={"X-API-Key": api_key},
                )
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            raise ProviderError(
                f"视频接口连不上: {exc}",
                code="PROVIDER_UNREACHABLE",
                retryable=True,
            ) from exc
        except httpx.HTTPError as exc:
            if result_unknown_on_transport_error:
                raise ProviderError(
                    f"视频提交请求已发出但没拿到结果，不重试以免重复计费: {exc}",
                    code="PROVIDER_RESULT_UNKNOWN",
                    retryable=False,
                ) from exc
            raise ProviderError(
                f"视频接口不可达: {exc}",
                code="PROVIDER_UNREACHABLE",
                retryable=True,
            ) from exc
        if response.status_code >= 500:
            raise ProviderError(
                f"视频接口返回 {response.status_code}",
                code="PROVIDER_SERVER_ERROR",
                retryable=True,
            )
        if response.status_code >= 400:
            raise ProviderError(
                f"视频接口拒绝了这次请求（{response.status_code}）: {response.text[:500]}",
                code="PROVIDER_REJECTED",
                retryable=False,
            )
        try:
            body = response.json()
        except ValueError as exc:
            raise ProviderError(
                "视频接口的响应不是 JSON",
                code="PROVIDER_MALFORMED",
                retryable=True,
            ) from exc
        if not isinstance(body, dict):
            raise ProviderError(
                "视频接口的响应根不是 object",
                code="PROVIDER_MALFORMED",
                retryable=True,
            )
        return body


def _with_model(payload: dict[str, Any], upstream_model: str | None) -> dict[str, Any]:
    return payload if upstream_model is None else {**payload, "model": upstream_model}


def _progress_from_body(
    body: dict[str, Any], *, job_id: uuid.UUID, task_id: str
) -> ProviderProgress:
    status_value = body.get("status")
    if not isinstance(status_value, str) or not status_value.strip():
        raise ProviderError(
            "视频状态响应里没有 status",
            code="PROVIDER_MALFORMED",
            retryable=True,
        )
    status = status_value.strip().lower()

    if status == _SUCCEEDED_STATUS:
        raw_result = body.get("result")
        result: dict[str, Any] = raw_result if isinstance(raw_result, dict) else {}
        urls = {key: result.get(key) for key in ("output_url", "watermark_output_url")}
        missing = [
            key
            for key, value in urls.items()
            if not isinstance(value, str) or not is_http_url(value)
        ]
        if missing:
            raise ProviderError(
                f"视频接口报成功但没给 result.{' / result.'.join(missing)}",
                code="PROVIDER_OUTPUT_MISSING",
                retryable=False,
            )
        return ProviderProgress(
            outcome="succeeded",
            provider_status=status,
            output_url=str(urls["output_url"]),
            watermark_output_url=str(urls["watermark_output_url"]),
            duration_ms=_output_duration_ms(result, job_id=job_id, task_id=task_id),
        )

    if status in _FAILED_STATUSES:
        code, message = _error_fields(body.get("error"))
        return ProviderProgress(
            outcome="failed",
            provider_status=status,
            error_code=code or f"PROVIDER_{status.upper()}",
            error_message=message or f"provider 状态为 {status}",
        )

    if status in _RUNNING_STATUSES:
        return ProviderProgress(outcome="running", provider_status=status)

    raise ProviderError(
        f"没见过的视频生成状态: {status}",
        code="PROVIDER_STATUS_UNKNOWN",
        retryable=False,
    )


def _output_duration_ms(result: dict[str, Any], *, job_id: uuid.UUID, task_id: str) -> int | None:
    if "output_duration_seconds" not in result:
        return None
    seconds = result["output_duration_seconds"]
    if isinstance(seconds, (int, float)) and not isinstance(seconds, bool):
        scaled = seconds * 1000
        if isinstance(scaled, int) or math.isfinite(scaled):
            ms = round(scaled)
            if 0 < ms <= _MAX_DURATION_MS:
                return ms
    _logger.warning(
        "视频上游给的产物时长不可用",
        job_id=job_id,
        task_id=task_id,
        output_duration_seconds=seconds,
    )
    return None


def _error_fields(error: Any) -> tuple[str | None, str | None]:
    if isinstance(error, str) and error.strip():
        return None, error.strip()
    if isinstance(error, dict):
        code = error.get("code")
        message = error.get("message")
        upstream_message = error.get("upstream_message")
        if (
            code == "PROVIDER_ERROR"
            and isinstance(upstream_message, str)
            and upstream_message.strip()
        ):
            message = upstream_message
        return (
            code.strip() if isinstance(code, str) and code.strip() else None,
            message.strip() if isinstance(message, str) and message.strip() else None,
        )
    return None, None


__all__ = ["PROVIDER_NAME", "HttpVideoProvider", "VideoProviderSettings"]
