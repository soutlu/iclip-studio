from __future__ import annotations

import json
import uuid
from collections.abc import Sequence
from typing import Any, Final

import httpx
from pydantic import BaseModel, ConfigDict, TypeAdapter, ValidationError

from iclip_video.plugin_services import PluginServices
from iclip_video.shot_video.ports import (
    AnchorSheets,
    BoardsResult,
    ExtractionLedger,
    GridCutFailed,
    ImageJob,
    ImageJobUnavailable,
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
    ImageSubmission,
)
from iclip_video.video_breakdown.ports import FailedBreakdown
from iclip_video.video_breakdown.wire import ReferenceBreakdownCall, ReferenceBreakdownResult

PLUGINS_PATH: Final = "/internal/runtime/plugins"

CONNECT_TIMEOUT_SECONDS: Final = 10.0

POLL_TIMEOUT: Final = httpx.Timeout(30.0, connect=CONNECT_TIMEOUT_SECONDS)

_UNAVAILABLE_STATUSES: Final = frozenset({502, 503, 504})

_EXCERPT_LIMIT: Final = 300

_IMAGE_JOB: Final = TypeAdapter(ImageJob)
_BOARDS_RESULT: Final = TypeAdapter(BoardsResult)
_GRID_CUT_RESULT: Final = TypeAdapter(GridCutResult)
_BREAKDOWN_RESULT: Final = TypeAdapter(ReferenceBreakdownResult)
_PLUGIN_SERVICES: Final = TypeAdapter(PluginServices)


class InternalApiError(RuntimeError):
    pass


class InternalApiUnavailable(InternalApiError):
    pass


class _Envelope(BaseModel):
    model_config = ConfigDict(extra="ignore")

    detail: str


class InternalApi:
    def __init__(self, client: httpx.AsyncClient) -> None:
        self._client = client

    async def send(
        self,
        method: str,
        path: str,
        *,
        body: dict[str, Any] | None = None,
        params: dict[str, str] | None = None,
        timeout: httpx.Timeout | None = None,
    ) -> httpx.Response:
        where = f"{method} {PLUGINS_PATH}{path}"
        try:
            return await self._client.request(
                method,
                f"{PLUGINS_PATH}{path}",
                json=body,
                params=params,
                timeout=timeout if timeout is not None else httpx.USE_CLIENT_DEFAULT,
            )
        except httpx.TransportError as exc:
            raise InternalApiUnavailable(
                f"后端内部接口 {where} 连不上（{type(exc).__name__}）"
            ) from exc
        except httpx.HTTPError as exc:
            raise InternalApiError(f"后端内部接口 {where} 没发成（{type(exc).__name__}）") from exc

    def answer[T](self, response: httpx.Response, adapter: TypeAdapter[T]) -> T:
        if not response.is_success:
            raise self.unexpected(response)
        try:
            return adapter.validate_json(response.content, extra="ignore")
        except ValidationError as exc:
            raise self.unexpected(response, why="答复的形状不对") from exc

    def detail(self, response: httpx.Response) -> str:
        try:
            return _Envelope.model_validate_json(response.content).detail
        except ValidationError as exc:
            raise self.unexpected(response, why="答复不是错误信封") from exc

    def failure[F: BaseModel](self, response: httpx.Response, model: type[F]) -> F:
        try:
            payload = json.loads(response.content)
        except ValueError as exc:
            raise self.unexpected(response, why="答复不是 JSON") from exc
        if not isinstance(payload, dict) or "code" not in payload:
            raise self.unexpected(response, why="答复里没有 code")
        try:
            return model.model_validate(payload, extra="ignore")
        except ValidationError as exc:
            raise self.unexpected(response, why="答复的形状不对") from exc

    @staticmethod
    def unexpected(response: httpx.Response, *, why: str | None = None) -> InternalApiError:
        request = response.request
        reason = f"，{why}" if why is not None else ""
        kind = (
            InternalApiUnavailable
            if response.status_code in _UNAVAILABLE_STATUSES
            else InternalApiError
        )
        return kind(
            f"后端内部接口 {request.method} {request.url.path} 答 {response.status_code}{reason}："
            f"{response.text[:_EXCERPT_LIMIT]}"
        )


class HttpImageGenerations:
    def __init__(self, api: InternalApi) -> None:
        self._api = api

    async def submit(self, user_id: uuid.UUID, request: ImageRequest) -> ImageJob:
        body = ImageSubmission(user_id=user_id, request=request).model_dump(mode="json")
        response = await self._api.send("POST", "/generations", body=body)
        if response.status_code == 422:
            raise InvalidImageRequest(self._api.detail(response))
        return self._api.answer(response, _IMAGE_JOB)

    async def get(self, user_id: uuid.UUID, job_id: uuid.UUID) -> ImageJob:
        try:
            response = await self._api.send(
                "GET",
                f"/generations/{job_id}",
                params={"user_id": str(user_id)},
                timeout=POLL_TIMEOUT,
            )
            return self._api.answer(response, _IMAGE_JOB)
        except InternalApiUnavailable as exc:
            raise ImageJobUnavailable(str(exc)) from exc


class HttpFrameBoards:
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
        response = await self._api.send(
            "POST", "/frame-boards", body=call.model_dump(mode="json", by_alias=True)
        )
        if response.status_code == 422:
            raise self._api.failure(response, FrameBoardsFailure).error()
        return self._api.answer(response, _BOARDS_RESULT)


class HttpGridCuts:
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
    def __init__(self, api: InternalApi) -> None:
        self._api = api

    async def ensure(self, user_id: uuid.UUID, video_url: str) -> str | FailedBreakdown:
        body = ReferenceBreakdownCall(user_id=user_id, video_url=video_url).model_dump(mode="json")
        response = await self._api.send("POST", "/reference-breakdowns", body=body)
        return self._api.answer(response, _BREAKDOWN_RESULT).outcome()


async def plugin_services(api: InternalApi) -> PluginServices:
    response = await api.send("GET", "/services")
    return api.answer(response, _PLUGIN_SERVICES)


__all__ = [
    "CONNECT_TIMEOUT_SECONDS",
    "PLUGINS_PATH",
    "POLL_TIMEOUT",
    "HttpFrameBoards",
    "HttpGridCuts",
    "HttpImageGenerations",
    "HttpReferenceBreakdowns",
    "InternalApi",
    "InternalApiError",
    "InternalApiUnavailable",
    "plugin_services",
]
