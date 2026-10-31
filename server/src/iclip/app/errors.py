"""HTTP 错误信封：领域错误与请求校验错误都返回 ``{"detail": "<一句话>"}``，文档里的 422 也照这个形状。

状态码表、信封、校验文案与 OpenAPI 里 422 的改写都用运行时的 ``agent_runtime.http.errors``，后端转发运行时的
答复与自己的报错同一个形状；后端只多一条：运行时服务答不上一律 503。组合根与各域的 API 测试装同一份。
"""

from __future__ import annotations

from typing import Final

import structlog
from agent_runtime.client import AppRejected, RuntimeUnavailable
from agent_runtime.http.errors import install_error_handlers as install_runtime_error_handlers
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

_logger = structlog.stdlib.get_logger(__name__)

RUNTIME_UNAVAILABLE_DETAIL: Final = "运行时服务暂时不可用，请稍后再试"


def install_error_handlers(app: FastAPI) -> None:
    """装上运行时那一套（领域错误按分类映射状态码，请求校验失败一律 422，OpenAPI 里的 422 改成同一个字符串
    信封），再加运行时服务答不上一律 503。"""

    install_runtime_error_handlers(app)

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


__all__ = ["RUNTIME_UNAVAILABLE_DETAIL", "install_error_handlers"]
