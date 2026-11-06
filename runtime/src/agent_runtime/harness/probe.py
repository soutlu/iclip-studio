from __future__ import annotations

import asyncio
import time
from collections.abc import Callable, Collection, Mapping
from dataclasses import dataclass
from typing import Final, cast

import structlog
from pydantic_ai.direct import model_request
from pydantic_ai.exceptions import (
    ModelAPIError,
    ModelAuthenticationError,
    ModelConnectionError,
    ModelHTTPError,
    ModelNotFoundError,
    ModelQuotaExceededError,
    ModelRateLimitError,
    ModelTimeoutError,
    UserError,
)
from pydantic_ai.messages import ModelRequest
from pydantic_ai.models import Model
from pydantic_ai.settings import ModelSettings

_logger = structlog.stdlib.get_logger(__name__)

PROBE_MAX_TOKENS: Final = 16

PROBE_TIMEOUT_SECONDS: Final = 15.0

PROBE_PROMPT: Final = "ping"

_MAX_DETAIL_CHARS: Final = 200

_REDACTED: Final = "••••"


@dataclass(frozen=True, slots=True)
class ProbeOutcome:
    ok: bool
    elapsed_ms: int
    reason: str | None = None


def scrub(text: str, secrets: Collection[str]) -> str:
    for secret in sorted((one for one in secrets if one), key=len, reverse=True):
        text = text.replace(secret, _REDACTED)
    return text


def _upstream_message(body: object) -> str | None:
    if not isinstance(body, Mapping):
        return None
    payload = cast("Mapping[str, object]", body)
    error = payload.get("error")
    source = cast("Mapping[str, object]", error) if isinstance(error, Mapping) else payload
    message = source.get("message")
    return message if isinstance(message, str) and message.strip() else None


def describe_failure(exc: BaseException, *, timeout_seconds: float) -> str:
    status = f"（HTTP {exc.status_code}）" if isinstance(exc, ModelHTTPError) else ""
    detail = _upstream_message(exc.body) if isinstance(exc, ModelAPIError) else None
    suffix = f"：{detail[:_MAX_DETAIL_CHARS]}" if detail else ""
    if isinstance(exc, TimeoutError | ModelTimeoutError):
        return f"{timeout_seconds:g} 秒内没有答复"
    if isinstance(exc, ModelConnectionError):
        return "连不上接口地址"
    if isinstance(exc, ModelAuthenticationError):
        return f"API Key 无效或没有权限{status}{suffix}"
    if isinstance(exc, ModelNotFoundError):
        return f"接口找不到这个模型{status}{suffix}"
    if isinstance(exc, ModelRateLimitError | ModelQuotaExceededError):
        return f"被限流或额度不足{status}{suffix}"
    if isinstance(exc, ModelAPIError):
        return f"接口调用失败{status}{suffix}"
    return f"试连出错（{type(exc).__name__}）"


async def probe_model(
    build: Callable[[], Model],
    *,
    label: str,
    secrets: Collection[str],
    timeout_seconds: float = PROBE_TIMEOUT_SECONDS,
    max_tokens: int = PROBE_MAX_TOKENS,
) -> ProbeOutcome:
    started = time.monotonic()

    def failed(reason: str, exc: Exception) -> ProbeOutcome:
        cleaned = scrub(reason, secrets)
        _logger.info("模型试连失败", model=label, error_type=type(exc).__name__, reason=cleaned)
        return ProbeOutcome(
            ok=False, elapsed_ms=int((time.monotonic() - started) * 1000), reason=cleaned
        )

    try:
        model = build()
    except (RuntimeError, ValueError, UserError) as exc:
        return failed(f"按声明建不出模型：{exc}", exc)
    settings = ModelSettings(max_tokens=max_tokens, timeout=timeout_seconds, max_retries=0)
    try:
        async with asyncio.timeout(timeout_seconds):
            await model_request(
                model, [ModelRequest.user_text_prompt(PROBE_PROMPT)], model_settings=settings
            )
    except Exception as exc:
        return failed(describe_failure(exc, timeout_seconds=timeout_seconds), exc)
    return ProbeOutcome(ok=True, elapsed_ms=int((time.monotonic() - started) * 1000))


__all__ = [
    "PROBE_MAX_TOKENS",
    "PROBE_TIMEOUT_SECONDS",
    "ProbeOutcome",
    "describe_failure",
    "probe_model",
    "scrub",
]
