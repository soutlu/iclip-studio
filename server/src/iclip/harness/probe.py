"""试连一个模型：发一个最小的请求，交回通没通、耗时与一句不带机密的失败原因。"""

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
"""OpenAI 的 Responses 接口不收小于 16 的输出上限。"""

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
    """把 ``secrets`` 里的每个值从 ``text`` 里抹掉。"""

    for secret in sorted((one for one in secrets if one), key=len, reverse=True):
        text = text.replace(secret, _REDACTED)
    return text


def _upstream_message(body: object) -> str | None:
    """上游错误体里给人看的那句：``{"error": {"message"}}`` 或 ``{"message"}``。"""

    if not isinstance(body, Mapping):
        return None
    payload = cast("Mapping[str, object]", body)
    error = payload.get("error")
    source = cast("Mapping[str, object]", error) if isinstance(error, Mapping) else payload
    message = source.get("message")
    return message if isinstance(message, str) and message.strip() else None


def describe_failure(exc: BaseException, *, timeout_seconds: float) -> str:
    """一次失败的请求换成给人看的一句话。只用状态码、错误类别与上游错误体里的那句说明，不用异常的完整
    文本：那里可能带着请求。"""

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
    """用 ``build()`` 建出的模型发一个最小的请求，不重试。建不出模型与请求失败都放进结果，原因里抹掉
    ``secrets``；``label`` 只用来记日志。"""

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
        # 这几类是 build_model 对配置组合的拒绝，消息里只有 provider 名与字段名。
        return failed(f"按声明建不出模型：{exc}", exc)
    settings = ModelSettings(max_tokens=max_tokens, timeout=timeout_seconds, max_retries=0)
    try:
        async with asyncio.timeout(timeout_seconds):
            await model_request(
                model, [ModelRequest.user_text_prompt(PROBE_PROMPT)], model_settings=settings
            )
    except Exception as exc:
        # 试连的任何失败都是要交给人看的结果，不是服务端错误；原因已分类，类型另记日志。
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
