from __future__ import annotations

import asyncio
import hmac
import uuid
from collections.abc import Awaitable, Callable, Coroutine
from dataclasses import dataclass
from typing import Any, Final

import structlog
from agent_runtime.errors import (
    AuthenticationFailed,
    NotFound,
    PermissionDenied,
    ValidationFailed,
)
from agent_runtime.hooks import GatePayload, RunStartedPayload, TurnStartedPayload
from fastapi import APIRouter, Depends, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from iclip_video.plugin_services import PluginServices, ShotVideoServices
from iclip_video.shot_video.ports import (
    BoardsResult,
    FrameBoards,
    FrameBoardsFailed,
    GridCutFailed,
    GridCuts,
    ImageGenerations,
    ImageJob,
    InvalidImageRequest,
)
from iclip_video.shot_video.wire import (
    FrameBoardsCall,
    FrameBoardsFailure,
    GridCutCall,
    GridCutFailure,
    GridCutResult,
    ImageSubmission,
)
from iclip_video.video_breakdown.ports import ReferenceBreakdowns
from iclip_video.video_breakdown.wire import ReferenceBreakdownCall, ReferenceBreakdownResult
from pydantic import BaseModel, ValidationError

from iclip.domains.conversations.service import ConversationActivity, ConversationService
from iclip.domains.identity.public import AGENT_MANAGE_PERMISSION, Principal

_logger = structlog.stdlib.get_logger(__name__)

RUNTIME_INTERNAL_PREFIX: Final = "/internal/runtime"

ResolvePrincipal = Callable[[uuid.UUID], Awaitable[Principal]]


@dataclass(frozen=True, slots=True)
class ShotServices:
    generations: ImageGenerations
    boards: FrameBoards
    cuts: GridCuts
    image_models: frozenset[str]


@dataclass(frozen=True, slots=True)
class RuntimePluginServices:
    shot_video: ShotServices | None
    breakdowns: ReferenceBreakdowns | None

    def answer(self) -> PluginServices:
        shot = self.shot_video
        return PluginServices(
            shot_video=(
                ShotVideoServices(image_models=tuple(sorted(shot.image_models)))
                if shot is not None
                else None
            ),
            video_breakdown=self.breakdowns is not None,
        )


class _BadToken(AuthenticationFailed):
    pass


class _InternalRoute(APIRoute):
    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        handler = super().get_route_handler()

        async def route(request: Request) -> Response:
            try:
                return await handler(request)
            except _BadToken:
                raise
            except AuthenticationFailed as exc:
                raise PermissionDenied(str(exc)) from exc

        return route


def _bearer_check(token: str) -> Callable[[Request], Awaitable[None]]:
    expected = token.encode()

    async def check(request: Request) -> None:
        scheme, _, presented = request.headers.get("authorization", "").partition(" ")
        if scheme.lower() != "bearer" or not hmac.compare_digest(
            presented.strip().encode(), expected
        ):
            raise _BadToken("运行时内部接口的令牌不对")

    return check


async def _hook_payload[P: BaseModel](request: Request, model: type[P]) -> P:
    try:
        return model.model_validate_json(await request.body(), extra="ignore")
    except ValidationError as exc:
        raise RequestValidationError(exc.errors()) from exc


class TurnNaming:
    def __init__(self, conversations: ConversationService) -> None:
        self._conversations = conversations
        self._tasks: set[asyncio.Task[None]] = set()

    def start(self, conversation_id: uuid.UUID, text: str) -> None:
        task = asyncio.create_task(self._name(conversation_id, text))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _name(self, conversation_id: uuid.UUID, text: str) -> None:
        try:
            await self._conversations.name_at_turn_start(conversation_id, text)
        except NotFound:
            _logger.info("对话已删除，跳过自动起名", conversation_id=str(conversation_id))
        except Exception:
            _logger.exception("自动起名失败", conversation_id=str(conversation_id))

    async def wait(self) -> None:
        await asyncio.gather(*tuple(self._tasks), return_exceptions=True)

    async def aclose(self) -> None:
        pending = tuple(self._tasks)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)


def create_runtime_internal_router(
    *,
    token: str,
    user_principal: ResolvePrincipal,
    conversations: ConversationService,
    naming: TurnNaming,
    plugins: RuntimePluginServices,
) -> APIRouter:
    router = APIRouter(
        prefix=RUNTIME_INTERNAL_PREFIX,
        include_in_schema=False,
        dependencies=[Depends(_bearer_check(token))],
        route_class=_InternalRoute,
    )

    @router.post("/hooks/gate", status_code=204)
    async def gate(request: Request) -> Response:
        payload = await _hook_payload(request, GatePayload)
        owner = await user_principal(payload.owner_user_id)
        if payload.preview and not owner.has(AGENT_MANAGE_PERMISSION):
            raise PermissionDenied("预览的属主已不能管理 agent")
        return Response(status_code=204)

    @router.post("/hooks/run-started", status_code=204)
    async def run_started(request: Request) -> Response:
        payload = await _hook_payload(request, RunStartedPayload)
        if payload.preview:
            return Response(status_code=204)
        reported = payload.activity
        await conversations.begin_reported_run(
            payload.session_id,
            run_id=payload.run_id,
            activity=ConversationActivity(
                busy=reported.busy,
                pending_interaction=reported.pending_interaction,
                last_turn_reason=reported.last_turn_reason,
            ),
        )
        return Response(status_code=204)

    @router.post("/hooks/turn-started", status_code=204)
    async def turn_started(request: Request) -> Response:
        payload = await _hook_payload(request, TurnStartedPayload)
        if not payload.preview:
            naming.start(payload.session_id, payload.text)
        return Response(status_code=204)

    answer = plugins.answer()

    @router.get("/plugins/services")
    async def plugin_services() -> PluginServices:
        return answer

    if plugins.shot_video is not None:
        _image_routes(router, plugins.shot_video.generations)
        _boards_route(router, plugins.shot_video.boards)
        _cuts_route(router, plugins.shot_video.cuts)
    if plugins.breakdowns is not None:
        _breakdown_route(router, plugins.breakdowns)
    return router


def _image_routes(router: APIRouter, generations: ImageGenerations) -> None:
    @router.post("/plugins/generations")
    async def submit_image(body: ImageSubmission) -> ImageJob:
        try:
            return await generations.submit(body.user_id, body.request)
        except InvalidImageRequest as exc:
            raise ValidationFailed(str(exc)) from exc

    @router.get("/plugins/generations/{job_id}")
    async def image_job(job_id: uuid.UUID, user_id: uuid.UUID) -> ImageJob:
        return await generations.get(user_id, job_id)


def _boards_route(router: APIRouter, boards: FrameBoards) -> None:
    @router.post("/plugins/frame-boards", response_model=BoardsResult)
    async def frame_boards(body: FrameBoardsCall) -> BoardsResult | JSONResponse:
        try:
            return await boards.boards(
                video_url=body.video_url, rows=body.rows, previous=body.previous
            )
        except FrameBoardsFailed as exc:
            return JSONResponse(
                status_code=422, content=FrameBoardsFailure.of(exc).model_dump(mode="json")
            )


def _cuts_route(router: APIRouter, cuts: GridCuts) -> None:
    @router.post("/plugins/grid-cuts", response_model=GridCutResult)
    async def grid_cuts(body: GridCutCall) -> GridCutResult | JSONResponse:
        try:
            urls = await cuts.cut(
                body.user_id,
                body.job_id,
                grid_url=body.grid_url,
                cells=body.cells,
                aspect=body.aspect,
            )
        except GridCutFailed as exc:
            return JSONResponse(
                status_code=422, content=GridCutFailure(detail=str(exc)).model_dump(mode="json")
            )
        return GridCutResult(urls=urls)


def _breakdown_route(router: APIRouter, breakdowns: ReferenceBreakdowns) -> None:
    @router.post("/plugins/reference-breakdowns")
    async def reference_breakdown(body: ReferenceBreakdownCall) -> ReferenceBreakdownResult:
        return ReferenceBreakdownResult.of(await breakdowns.ensure(body.user_id, body.video_url))


__all__ = [
    "RUNTIME_INTERNAL_PREFIX",
    "ResolvePrincipal",
    "RuntimePluginServices",
    "ShotServices",
    "TurnNaming",
    "create_runtime_internal_router",
]
