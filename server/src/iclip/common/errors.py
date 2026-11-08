from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, Final


class DomainError(Exception):
    code: str | None = None


class NotFound(DomainError):
    pass


class PermissionDenied(DomainError):
    pass


class Conflict(DomainError):
    pass


class ValidationFailed(DomainError):
    pass


class AuthenticationFailed(DomainError):
    pass


class AgentUnavailable(Conflict):
    code = "agent_unavailable"


class ModelUnavailable(Conflict):
    code = "model_unavailable"


_REQUEST_PARTS: Final = frozenset({"body", "query", "path", "header", "cookie"})

_PYDANTIC_PREFIX: Final = "Value error, "

_FALLBACK: Final = "请求格式无效"


def validation_error_detail(errors: Sequence[Mapping[str, Any]]) -> str:
    first = next(iter(errors), None)
    if first is None:
        return _FALLBACK
    message = str(first.get("msg", "")).removeprefix(_PYDANTIC_PREFIX).strip() or _FALLBACK
    if first.get("type") == "json_invalid":
        return message
    location = _location_of(first.get("loc", ()))
    return f"{location}: {message}" if location else message


def _location_of(loc: Sequence[Any]) -> str:
    parts = list(loc)
    if parts and parts[0] in _REQUEST_PARTS:
        parts = parts[1:]
    rendered = ""
    for part in parts:
        if isinstance(part, int):
            rendered += f"[{part}]"
        elif rendered:
            rendered += f".{part}"
        else:
            rendered = str(part)
    return rendered


__all__ = [
    "AgentUnavailable",
    "AuthenticationFailed",
    "Conflict",
    "DomainError",
    "ModelUnavailable",
    "NotFound",
    "PermissionDenied",
    "ValidationFailed",
    "validation_error_detail",
]
