from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol

from iclip.domains.generation.models import GenerationJob
from iclip.domains.generation.schemas import (
    ImageGenerationIn,
    SubtitleSentence,
    VideoEnhanceRequest,
    VideoGenerationIn,
)

ProviderOutcome = Literal["running", "succeeded", "failed"]


class ProviderError(Exception):
    def __init__(self, message: str, *, code: str, retryable: bool) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable


def request_of[R](
    job: GenerationJob, expected: type[R] | tuple[type[R], ...], *, provider: str
) -> R:
    request = job.request
    if not isinstance(request, expected):
        raise ProviderError(
            f"{provider} 收到了 {job.kind} / {job.operation} 请求",
            code="PROVIDER_KIND_MISMATCH",
            retryable=False,
        )
    return request


def user_name_of(request: VideoGenerationIn | ImageGenerationIn | VideoEnhanceRequest) -> str:
    if request.user_name is None:
        raise ProviderError(
            "生成请求没有 user_name",
            code="PROVIDER_USER_NAME_MISSING",
            retryable=False,
        )
    return request.user_name


@dataclass(frozen=True, slots=True)
class ImageModelSpec:
    label: str

    aspect_ratios: tuple[str, ...]
    resolutions: tuple[str, ...]

    channels: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class ProviderSubmission:
    provider_task_id: str
    provider_status: str
    output_url: str | None = None
    duration_ms: int | None = None
    sentences: tuple[SubtitleSentence, ...] | None = None


@dataclass(frozen=True, slots=True)
class ProviderProgress:
    outcome: ProviderOutcome
    provider_status: str
    output_url: str | None = None
    watermark_output_url: str | None = None
    duration_ms: int | None = None
    error_code: str | None = None
    error_message: str | None = None


class GenerationProvider(Protocol):
    @property
    def name(self) -> str: ...

    async def submit(self, job: GenerationJob) -> ProviderSubmission: ...

    async def poll(self, job: GenerationJob) -> ProviderProgress: ...


__all__ = [
    "GenerationProvider",
    "ImageModelSpec",
    "ProviderError",
    "ProviderOutcome",
    "ProviderProgress",
    "ProviderSubmission",
    "request_of",
    "user_name_of",
]
