"""出图、取帧拼板、宫格切格与参考视频拆解四个端口的 HTTP 实现：调后端给运行时的内部接口。

路径、请求、答复与状态码见 contract/conventions.md §21；请求与答复用各插件包 ``wire.py`` 里的模型，与后端
那一侧共用。后端答的 422 还原成端口声明的错误、原话不变，工具照进程内那样处理。其余失败（连不上、超时、
令牌不对、404、5xx、答复形状不对）抛 ``InternalApiError``：与进程内适配器的意外错误一样，工具不接，
这次工具调用失败，不翻成让模型改参数的错误。
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Sequence
from typing import Any, Final

import httpx
from pydantic import BaseModel, ConfigDict, TypeAdapter, ValidationError

from iclip_video.shot_video.ports import (
    AnchorSheets,
    BoardsResult,
    ExtractionLedger,
    GridCutFailed,
    ImageJob,
    ImageRequest,
    InvalidImageRequest,
    ShotCells,
)
from iclip_video.shot_video.shots import ShotSpan
from iclip_video.shot_video.wire import (
    FrameBoardsCall,
    FrameBoardsFailure,
    GridCutCall,
    GridCutFailure,
    GridCutResult,
    ImageModels,
    ImageSubmission,
)
from iclip_video.video_breakdown.ports import FailedBreakdown
from iclip_video.video_breakdown.wire import ReferenceBreakdownCall, ReferenceBreakdownResult

PLUGINS_PATH: Final = "/internal/runtime/plugins"
"""插件服务在后端的路径前缀；客户端的 ``base_url`` 是后端的根地址。"""

_EXCERPT_LIMIT: Final = 300

_IMAGE_JOB: Final = TypeAdapter(ImageJob)
_BOARDS_RESULT: Final = TypeAdapter(BoardsResult)
_GRID_CUT_RESULT: Final = TypeAdapter(GridCutResult)
_BREAKDOWN_RESULT: Final = TypeAdapter(ReferenceBreakdownResult)
_IMAGE_MODELS: Final = TypeAdapter(ImageModels)


class InternalApiError(RuntimeError):
    """后端内部接口没给出约定的答复。消息带方法、路径与状态码或连接错误的类名，不带令牌。"""


class _Envelope(BaseModel):
    """后端的错误信封（conventions §4）；带 ``code`` 的失败另按自己的模型读。"""

    model_config = ConfigDict(extra="ignore")

    detail: str


class InternalApi:
    """后端内部接口的一层薄封装：``client`` 由组合根建好，带后端根地址、``Authorization: Bearer`` 令牌与
    超时；这里发请求、认状态码、按模型读答复，失败一律抛 ``InternalApiError``。"""

    def __init__(self, client: httpx.AsyncClient) -> None:
        self._client = client

    async def send(
        self,
        method: str,
        path: str,
        *,
        body: dict[str, Any] | None = None,
        params: dict[str, str] | None = None,
    ) -> httpx.Response:
        """发一次请求交回答复，不看状态码。

        Raises:
            InternalApiError: 连不上、超时等传输错误。
        """

        try:
            return await self._client.request(
                method, f"{PLUGINS_PATH}{path}", json=body, params=params
            )
        except httpx.HTTPError as exc:
            raise InternalApiError(
                f"后端内部接口 {method} {PLUGINS_PATH}{path} 连不上（{type(exc).__name__}）"
            ) from exc

    def answer[T](self, response: httpx.Response, adapter: TypeAdapter[T]) -> T:
        """2xx 的答复按 ``adapter`` 读出来。

        Raises:
            InternalApiError: 不是 2xx，或答复的形状不对。
        """

        if not response.is_success:
            raise self.unexpected(response)
        try:
            return adapter.validate_json(response.content)
        except ValidationError as exc:
            raise self.unexpected(response, why="答复的形状不对") from exc

    def detail(self, response: httpx.Response) -> str:
        """错误信封里的 ``detail``。

        Raises:
            InternalApiError: 答复不是错误信封。
        """

        try:
            return _Envelope.model_validate_json(response.content).detail
        except ValidationError as exc:
            raise self.unexpected(response, why="答复不是错误信封") from exc

    def failure[F: BaseModel](self, response: httpx.Response, model: type[F]) -> F:
        """带 ``code`` 的 422 按 ``model`` 读出来。请求结构校验失败的 422 只有 ``detail``、没有 ``code``，
        那是客户端发错了，不当成端口的失败。

        Raises:
            InternalApiError: 答复里没有 ``code``，或形状不合 ``model``。
        """

        try:
            payload = json.loads(response.content)
        except ValueError as exc:
            raise self.unexpected(response, why="答复不是 JSON") from exc
        if not isinstance(payload, dict) or "code" not in payload:
            raise self.unexpected(response, why="答复里没有 code")
        try:
            return model.model_validate(payload)
        except ValidationError as exc:
            raise self.unexpected(response, why="答复的形状不对") from exc

    @staticmethod
    def unexpected(response: httpx.Response, *, why: str | None = None) -> InternalApiError:
        """把一个不合约定的答复写成 ``InternalApiError``：状态码加答复开头一段。"""

        request = response.request
        reason = f"，{why}" if why is not None else ""
        return InternalApiError(
            f"后端内部接口 {request.method} {request.url.path} 答 {response.status_code}{reason}："
            f"{response.text[:_EXCERPT_LIMIT]}"
        )


class HttpImageGenerations:
    """``ImageGenerations`` 经 ``/plugins/generations``；提交被拒（422）还原成 ``InvalidImageRequest``。"""

    def __init__(self, api: InternalApi) -> None:
        self._api = api

    async def submit(self, user_id: uuid.UUID, request: ImageRequest) -> ImageJob:
        body = ImageSubmission(user_id=user_id, request=request).model_dump(mode="json")
        response = await self._api.send("POST", "/generations", body=body)
        if response.status_code == 422:
            raise InvalidImageRequest(self._api.detail(response))
        return self._api.answer(response, _IMAGE_JOB)

    async def get(self, user_id: uuid.UUID, job_id: uuid.UUID) -> ImageJob:
        response = await self._api.send(
            "GET", f"/generations/{job_id}", params={"user_id": str(user_id)}
        )
        return self._api.answer(response, _IMAGE_JOB)


class HttpFrameBoards:
    """``FrameBoards`` 经 ``/plugins/frame-boards``；422 按 ``code`` 还原成同一个 ``FrameBoardsFailed`` 子类。"""

    def __init__(self, api: InternalApi) -> None:
        self._api = api

    async def boards(
        self,
        *,
        video_url: str,
        rows: Sequence[Sequence[ShotSpan]],
        previous: ExtractionLedger | None,
    ) -> BoardsResult:
        call = FrameBoardsCall(
            video_url=video_url, rows=tuple(tuple(row) for row in rows), previous=previous
        )
        # 取帧台账在线上按它的 camelCase 别名。
        response = await self._api.send(
            "POST", "/frame-boards", body=call.model_dump(mode="json", by_alias=True)
        )
        if response.status_code == 422:
            raise self._api.failure(response, FrameBoardsFailure).error()
        return self._api.answer(response, _BOARDS_RESULT)


class HttpGridCuts:
    """``GridCuts`` 经 ``/plugins/grid-cuts``；没切成（422）还原成 ``GridCutFailed``，原因不变。"""

    def __init__(self, api: InternalApi) -> None:
        self._api = api

    async def cut(
        self,
        user_id: uuid.UUID,
        job_id: uuid.UUID,
        *,
        grid_url: str,
        cells: ShotCells | AnchorSheets,
        aspect: str | None,
    ) -> tuple[str, ...]:
        call = GridCutCall(
            user_id=user_id, job_id=job_id, grid_url=grid_url, cells=cells, aspect=aspect
        )
        response = await self._api.send("POST", "/grid-cuts", body=call.model_dump(mode="json"))
        if response.status_code == 422:
            raise GridCutFailed(self._api.failure(response, GridCutFailure).detail)
        return self._api.answer(response, _GRID_CUT_RESULT).urls


class HttpReferenceBreakdowns:
    """``ReferenceBreakdowns`` 经 ``/plugins/reference-breakdowns``；要排拆解时后端等到出结果才答，客户端的
    超时要比后端的等待上限长。"""

    def __init__(self, api: InternalApi) -> None:
        self._api = api

    async def ensure(self, user_id: uuid.UUID, video_url: str) -> str | FailedBreakdown:
        body = ReferenceBreakdownCall(user_id=user_id, video_url=video_url).model_dump(mode="json")
        response = await self._api.send("POST", "/reference-breakdowns", body=body)
        return self._api.answer(response, _BREAKDOWN_RESULT).outcome()


async def image_models(api: InternalApi) -> frozenset[str]:
    """后端接入的图片模型名，经 ``/plugins/image-models``。

    Raises:
        InternalApiError: 后端连不上或没给出约定的答复。
    """

    response = await api.send("GET", "/image-models")
    return frozenset(api.answer(response, _IMAGE_MODELS).models)


__all__ = [
    "PLUGINS_PATH",
    "HttpFrameBoards",
    "HttpGridCuts",
    "HttpImageGenerations",
    "HttpReferenceBreakdowns",
    "InternalApi",
    "InternalApiError",
    "image_models",
]
