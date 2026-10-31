"""HTTP 错误信封：领域错误与请求校验错误都返回 ``{"detail": "<一句话>"}``，文档里的 422 也照这个形状。

组合根与各域的 API 测试装同一份，信封的运行时与文档两面不会两边长歪。
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, Final

import structlog
from agent_runtime.client import AppRejected, RuntimeUnavailable
from agent_runtime.errors import DomainError
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from iclip.platform.http import status_code_for, validation_error_detail

_logger = structlog.stdlib.get_logger(__name__)

RUNTIME_UNAVAILABLE_DETAIL: Final = "运行时服务暂时不可用，请稍后再试"


def install_error_handlers(app: FastAPI) -> None:
    """装上三个异常处理器（领域错误按分类映射状态码，请求校验失败一律 422，运行时服务答不上一律 503），
    并把 OpenAPI 里的 422 改成同一个字符串信封。"""

    @app.exception_handler(RuntimeUnavailable)
    async def _runtime_unavailable_handler(
        _request: Request, exc: RuntimeUnavailable
    ) -> JSONResponse:
        """原因只进日志，答复里只有一句固定的话；两边都没有应用密钥。运行时不认后端这个应用是部署配错了，
        记一条错误；浏览器照样只看到不可用，不当成登录失效。"""

        if isinstance(exc, AppRejected):
            _logger.error(
                "运行时拒绝了后端的应用密钥或权限，检查 RUNTIME_APP_KEY 与运行时 apps.video 配置",
                status=exc.status,
                detail=exc.detail,
            )
        else:
            _logger.warning("运行时服务答不上", reason=exc.reason, status=exc.status)
        return JSONResponse(status_code=503, content={"detail": RUNTIME_UNAVAILABLE_DETAIL})

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
        """FastAPI 默认给的是每条一项的列表，调用方得自己拆，拆不动就只剩一个状态码。"""

        return JSONResponse(
            status_code=422,
            content={"detail": validation_error_detail(exc.errors())},
        )

    app.openapi = _openapi_with_string_validation_error(app)  # type: ignore[method-assign]


def _openapi_with_string_validation_error(app: FastAPI) -> Callable[[], dict[str, Any]]:
    """路由没声明 422 时 FastAPI 自动注入 ``HTTPValidationError``，改不了声明只能改成品；
    合同由 ``scripts/dump_openapi.py`` 从这里导出，前端类型跟着走。"""

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
