from __future__ import annotations

import httpx
import structlog
from fastapi import APIRouter
from fastapi.responses import JSONResponse, Response

from agent_runtime.app_wire import UPSTREAM_TIMEOUT_CODE, UPSTREAM_UNREACHABLE_CODE, ModelCallIn
from agent_runtime.model_connections import ModelConnectionLookup

_logger = structlog.stdlib.get_logger(__name__)

_OWN_FAILURE = {
    "description": "运行时自己的失败，信封带 code：没有能用的连接，或没拿到上游的答复",
    "content": {"application/json": {}},
}


def create_model_calls_router(
    connection: ModelConnectionLookup, client: httpx.AsyncClient
) -> APIRouter:
    router = APIRouter(tags=["model-calls"])

    @router.post(
        "/model-calls/responses",
        response_class=Response,
        responses={
            200: {"description": "上游的答复：状态码、内容类型与正文都原样", "content": {}},
            409: {
                **_OWN_FAILURE,
                "description": "code 为 model_unavailable：配置页里没有能用的连接",
            },
            502: {
                **_OWN_FAILURE,
                "description": f"code 为 {UPSTREAM_UNREACHABLE_CODE}：连不上上游",
            },
            504: {**_OWN_FAILURE, "description": f"code 为 {UPSTREAM_TIMEOUT_CODE}：等上游超时"},
        },
    )
    async def responses(body: ModelCallIn) -> Response:
        found = await connection(body.declaration, body.model)
        try:
            upstream = await client.post(
                found.responses_url,
                json={**body.payload, "model": body.model},
                headers={"Authorization": f"Bearer {found.api_key}"},
            )
        except httpx.TimeoutException as exc:
            _logger.warning(
                "模型调用等上游超时",
                declaration=body.declaration,
                model=body.model,
                error=type(exc).__name__,
            )
            return _own_failure(
                504, "等上游答复超时，无法确认上游执行过没有", UPSTREAM_TIMEOUT_CODE
            )
        except httpx.HTTPError as exc:
            _logger.warning(
                "模型调用连不上上游",
                declaration=body.declaration,
                model=body.model,
                error=type(exc).__name__,
            )
            return _own_failure(502, "连不上上游", UPSTREAM_UNREACHABLE_CODE)
        return Response(
            content=upstream.content,
            status_code=upstream.status_code,
            media_type=upstream.headers.get("content-type"),
        )

    return router


def _own_failure(status: int, detail: str, code: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"detail": detail, "code": code})


__all__ = ["create_model_calls_router"]
