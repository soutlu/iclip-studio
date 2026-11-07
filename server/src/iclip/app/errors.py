from __future__ import annotations

from typing import Final

import structlog
from cue.client import AppRejected, RuntimeUnavailable
from cue.http.errors import install_error_handlers as install_runtime_error_handlers
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

_logger = structlog.stdlib.get_logger(__name__)

RUNTIME_UNAVAILABLE_DETAIL: Final = "运行时服务暂时不可用，请稍后再试"


def install_error_handlers(app: FastAPI) -> None:
    install_runtime_error_handlers(app)

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


__all__ = ["RUNTIME_UNAVAILABLE_DETAIL", "install_error_handlers"]
