"""HTTP 错误信封：领域错误按分类映射状态码，请求校验错误压成一句话，都返回 ``{"detail": "<一句话>"}``，
领域错误带 ``code`` 时一并放进去；文档里的 422 也照这个形状。

状态码表、信封与校验文案和后端（``iclip.platform.http`` 与 ``iclip.app.errors``）逐条一致：
后端转发运行时的答复时原样交给浏览器。
"""

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
    """返回领域错误对应的 HTTP 状态码；未知子类归 500。"""

    for error_type, status in _STATUS_BY_TYPE:
        if isinstance(error, error_type):
            return status
    return 500


_REQUEST_PARTS: Final = frozenset({"body", "query", "path", "header", "cookie"})
"""Pydantic 位置的第一段是请求的哪一部分，对调用方没有信息量，拼文案时去掉。"""

_PYDANTIC_PREFIX: Final = "Value error, "
"""自定义校验器抛 ``ValueError`` 时 pydantic 加的前缀，去掉后就是我们自己写的那句话。"""

_FALLBACK: Final = "请求格式无效"


def validation_error_detail(errors: Sequence[Mapping[str, Any]]) -> str:
    """把请求校验错误压成一句话。

    取第一条：一次请求里后面几条通常是同一处问题的连带结果。形如 ``config.tools[0].toolset: ...``；
    位置为空（模型级校验器报在请求体自身）时只留原因。
    """

    first = next(iter(errors), None)
    if first is None:
        return _FALLBACK
    message = str(first.get("msg", "")).removeprefix(_PYDANTIC_PREFIX).strip() or _FALLBACK
    # 正文不是合法 JSON 时，位置的第二段是字符偏移而非字段，拼出来只会误导。
    if first.get("type") == "json_invalid":
        return message
    location = _location_of(first.get("loc", ()))
    return f"{location}: {message}" if location else message


def _location_of(loc: Sequence[Any]) -> str:
    """把 pydantic 的位置元组拼成字段路径：下标写成 ``[n]``，其余用 ``.`` 连接。"""

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
    """装上两个异常处理器（领域错误按分类映射状态码，请求校验失败一律 422），并把 OpenAPI
    里的 422 改成同一个字符串信封。"""

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
    """路由没声明 422 时 FastAPI 自动注入 ``HTTPValidationError``，改不了声明只能改成品。"""

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
