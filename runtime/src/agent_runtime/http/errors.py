from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from typing import Any, Final

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from agent_runtime.errors import (
    AuthenticationFailed,
    Conflict,
    DomainError,
    NotFound,
    PermissionDenied,
    ValidationFailed,
)

_STATUS_BY_TYPE: tuple[tuple[type[DomainError], int], ...] = (
    (NotFound, 404),
    (PermissionDenied, 403),
    (Conflict, 409),
    (ValidationFailed, 422),
    (AuthenticationFailed, 401),
)


def status_code_for(error: DomainError) -> int:
    for error_type, status in _STATUS_BY_TYPE:
        if isinstance(error, error_type):
            return status
    return 500


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


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(DomainError)
    async def _domain_error_handler(_request: Request, exc: DomainError) -> JSONResponse:
        content: dict[str, str] = {"detail": str(exc) or type(exc).__name__}
        if exc.code is not None:
            content["code"] = exc.code
        return JSONResponse(status_code=status_code_for(exc), content=content)

    @app.exception_handler(RequestValidationError)
    async def _validation_error_handler(
        _request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content={"detail": validation_error_detail(exc.errors())},
        )

    app.openapi = _openapi_with_string_validation_error(app)  # type: ignore[method-assign]


def _openapi_with_string_validation_error(app: FastAPI) -> Callable[[], dict[str, Any]]:
    default_openapi = app.openapi

    def openapi() -> dict[str, Any]:
        document = default_openapi()
        schemas = document.get("components", {}).get("schemas", {})
        if "HTTPValidationError" in schemas:
            schemas["HTTPValidationError"] = {
                "description": "请求校验失败，与领域错误同一个信封。",
                "properties": {"detail": {"title": "Detail", "type": "string"}},
                "required": ["detail"],
                "title": "HTTPValidationError",
                "type": "object",
            }
            schemas.pop("ValidationError", None)
        return document

    return openapi


__all__ = ["install_error_handlers", "status_code_for", "validation_error_detail"]
