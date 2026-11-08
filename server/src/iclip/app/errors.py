from __future__ import annotations

from collections.abc import Callable
from typing import Any, Final

import structlog
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from iclip.common.errors import (
    AuthenticationFailed,
    Conflict,
    DomainError,
    NotFound,
    PermissionDenied,
    ValidationFailed,
    validation_error_detail,
)
from iclip.platform.runtime_api.client import AppRejected, RuntimeUnavailable

_logger = structlog.stdlib.get_logger(__name__)

RUNTIME_UNAVAILABLE_DETAIL: Final = "运行时服务暂时不可用，请稍后再试"

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


def install_error_handlers(app: FastAPI) -> None:
    _install_domain_error_handlers(app)

    @app.exception_handler(RuntimeUnavailable)
    async def _runtime_unavailable_handler(
        _request: Request, exc: RuntimeUnavailable
    ) -> JSONResponse:
        if isinstance(exc, AppRejected):
            _logger.error(
                "运行时拒绝了后端的应用密钥或权限，检查 RUNTIME_APP_KEY 与运行时 apps.video 配置",
                status=exc.status,
                detail=exc.detail,
            )
        else:
            _logger.warning("运行时服务答不上", reason=exc.reason, status=exc.status)
        return JSONResponse(status_code=503, content={"detail": RUNTIME_UNAVAILABLE_DETAIL})


def _install_domain_error_handlers(app: FastAPI) -> None:
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


__all__ = ["RUNTIME_UNAVAILABLE_DETAIL", "install_error_handlers"]
