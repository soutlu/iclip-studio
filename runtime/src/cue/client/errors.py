from __future__ import annotations

from typing import Final

import httpx
from pydantic import BaseModel, ValidationError

from cue.errors import (
    AgentUnavailable,
    Conflict,
    DomainError,
    ModelUnavailable,
    NotFound,
    ValidationFailed,
)


class RuntimeUnavailable(Exception):
    def __init__(self, reason: str, *, status: int | None = None) -> None:
        super().__init__(reason if status is None else f"{reason}（HTTP {status}）")
        self.reason = reason
        self.status = status


class AppRejected(RuntimeUnavailable):
    def __init__(self, detail: str, *, status: int | None) -> None:
        super().__init__("运行时拒绝了这个应用" + (f"：{detail}" if detail else ""), status=status)
        self.detail = detail


class ModelCallTimedOut(RuntimeUnavailable):
    pass


class StreamClosed(RuntimeUnavailable):
    def __init__(self, code: int, detail: str = "") -> None:
        super().__init__(f"实时连接已关闭：{code}" + (f" {detail}" if detail else ""))
        self.code = code
        self.detail = detail


class _ErrorEnvelope(BaseModel):
    detail: str
    code: str | None = None


APP_REJECTION_STATUSES: Final = frozenset({401, 403})

_DOMAIN_BY_STATUS: Final[dict[int, type[DomainError]]] = {
    404: NotFound,
    409: Conflict,
    422: ValidationFailed,
}


def transport_failure(exc: httpx.HTTPError) -> RuntimeUnavailable:
    message = str(exc)
    return RuntimeUnavailable(
        f"请求运行时失败：{type(exc).__name__}" + (f"：{message}" if message else "")
    )


def app_rejection(response: httpx.Response) -> AppRejected:
    try:
        detail = _ErrorEnvelope.model_validate_json(response.content).detail
    except ValidationError:
        detail = ""
    return AppRejected(detail, status=response.status_code)


def envelope_code(response: httpx.Response) -> str | None:
    try:
        return _ErrorEnvelope.model_validate_json(response.content).code
    except ValidationError:
        return None


def error_for(response: httpx.Response) -> DomainError | RuntimeUnavailable:
    status = response.status_code
    if status in APP_REJECTION_STATUSES:
        return app_rejection(response)
    domain = _DOMAIN_BY_STATUS.get(status)
    if domain is None:
        reason = "运行时服务出错" if status >= 500 else "运行时答了约定之外的状态码"
        return RuntimeUnavailable(reason, status=status)
    try:
        envelope = _ErrorEnvelope.model_validate_json(response.content)
    except ValidationError:
        return RuntimeUnavailable("运行时的报错答复解析不了", status=status)
    if domain is Conflict and envelope.code == AgentUnavailable.code:
        return AgentUnavailable(envelope.detail)
    if domain is Conflict and envelope.code == ModelUnavailable.code:
        return ModelUnavailable(envelope.detail)
    error = domain(envelope.detail)
    if envelope.code is not None:
        error.code = envelope.code
    return error


__all__ = [
    "APP_REJECTION_STATUSES",
    "AppRejected",
    "ModelCallTimedOut",
    "RuntimeUnavailable",
    "StreamClosed",
    "app_rejection",
    "envelope_code",
    "error_for",
    "transport_failure",
]
