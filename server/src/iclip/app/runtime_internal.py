"""给运行时服务的内部接口：开跑检查、运行开始与轮次开始三个回调，以及插件经 HTTP 调的几个后端服务。

组合根总是挂上（``RUNTIME_INTERNAL_TOKEN`` 必填）；身份中间件不解析这组路由的凭证。路由不进 OpenAPI，路径、请求体、状态码与报错写在
contract/conventions.md §21。回调的请求体是运行时 ``agent_runtime.hooks`` 的模型，插件服务的请求与
答复在 ``iclip_video`` 各插件包的 ``wire.py``，与插件的 HTTP 客户端共用。回调与插件服务都调进程内
那一份领域服务与端口适配器，不另写一套。"""

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

from iclip.domains.conversations.service import ConversationActivity, ConversationService
from iclip.domains.identity.public import AGENT_MANAGE_PERMISSION, Principal

_logger = structlog.stdlib.get_logger(__name__)

RUNTIME_INTERNAL_PREFIX: Final = "/internal/runtime"

ResolvePrincipal = Callable[[uuid.UUID], Awaitable[Principal]]
"""按用户 id 重建用户主体；账号不存在抛 ``NotFound``，已停用抛 ``AuthenticationFailed``。"""


@dataclass(frozen=True, slots=True)
class ShotServices:
    """``shot_video`` 插件要的三个端口与接入的图片模型名，一起挂或一起不挂。"""

    generations: ImageGenerations
    boards: FrameBoards
    cuts: GridCuts
    image_models: frozenset[str]


@dataclass(frozen=True, slots=True)
class RuntimePluginServices:
    """插件端口在后端的实现，经内部接口给运行时服务用；为 None 的那组路由不挂，
    ``/plugins/services`` 照同一份如实回答挂了哪些。"""

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
    """请求没带内部令牌或带错了。"""


class _InternalRoute(APIRoute):
    """内部接口的路由：401 只留给令牌不对。按运行属主重建主体时账号已停用（``AuthenticationFailed``，
    开跑检查与插件服务的适配器里都会遇到）改报 ``PermissionDenied``，即 403。"""

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


class TurnNaming:
    """轮次开始回调交来的自动起名：每次一个后台任务，与这一轮的运行并行。

    起名要等运行时起标题（调模型），回调不等它；任务记在这里，关停时 ``aclose`` 取消没跑完的并等它们收尾。
    对话已删记一条 info，其余失败记一条带堆栈的错误日志，都不往外抛。"""

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
        """等此刻手上的起名都跑完；测试经它确认后台起名做没做。"""

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
    """建内部接口的路由，每条都要 ``Authorization: Bearer <token>``（定长比较），缺了或不对答 401。

    开跑检查经 ``user_principal`` 重建属主主体；轮次开始交给 ``naming`` 在后台起名。"""

    router = APIRouter(
        prefix=RUNTIME_INTERNAL_PREFIX,
        include_in_schema=False,
        dependencies=[Depends(_bearer_check(token))],
        route_class=_InternalRoute,
    )

    @router.post("/hooks/gate", status_code=204)
    async def gate(payload: GatePayload) -> Response:
        """属主账号还在、没停用才放行；不在 404，停用 403。预览会话另要属主此刻持 ``agent:manage``，
        没有是 403：预览只给持它的属主本人用，排着的消息也不例外。"""

        owner = await user_principal(payload.owner_user_id)
        if payload.preview and not owner.has(AGENT_MANAGE_PERMISSION):
            raise PermissionDenied("预览的属主已不能管理 agent")
        return Response(status_code=204)

    @router.post("/hooks/run-started", status_code=204)
    async def run_started(payload: RunStartedPayload) -> Response:
        """记录运行并广播整行，行里的活动用回调带来的那份；对话不存在或已删 404。预览会话不是对话，
        什么都不做。"""

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
    async def turn_started(payload: TurnStartedPayload) -> Response:
        """按这一轮的用户文本在后台起标题，不等它起完就答 204。预览没有标题，不起。"""

        if not payload.preview:
            naming.start(payload.session_id, payload.text)
        return Response(status_code=204)

    answer = plugins.answer()

    @router.get("/plugins/services")
    async def plugin_services() -> PluginServices:
        """挂了哪些插件服务；运行时启动时照它核对配了的插件。"""

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
        """提交出图；请求不合法 422，原话同进程内交给工具的那句。

        插件按运行时会话类型给出归属：测试预览的 ``conversation_id`` 为空，预览被换掉后的在途请求也一样。
        从这张宫格切出的图沿用它的对话归属。"""

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
        """取帧拼板；端口的三种失败各答 422，带给模型的原话与认出子类的 ``code``。"""

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
        """切格转存并记切图；没切成 422，切图记录落不下照原样成 5xx。"""

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
        """交回拆解文档，没拆成交回原因；要排拆解时等到出结果才答。"""

        return ReferenceBreakdownResult.of(await breakdowns.ensure(body.user_id, body.video_url))


__all__ = [
    "RUNTIME_INTERNAL_PREFIX",
    "ResolvePrincipal",
    "RuntimePluginServices",
    "ShotServices",
    "TurnNaming",
    "create_runtime_internal_router",
]
