from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final, Literal

import httpx
import structlog
from pydantic import BaseModel, ConfigDict, ValidationError
from pydantic.alias_generators import to_camel

from iclip.common.final_cut import MAIN_FILE, media_addresses
from iclip.domains.generation.models import GenerationJob
from iclip.domains.generation.provider import (
    ProviderError,
    ProviderProgress,
    ProviderSubmission,
    request_of,
)
from iclip.domains.generation.schemas import WholeFilmRequest
from iclip.platform.object_store.layout import MEDIA_PATHS
from iclip.platform.object_store.store import ServerUploadSigner

_logger = structlog.stdlib.get_logger(__name__)

PROVIDER_NAME: Final = "whole_film_render"

RENDER_TIMEOUT_SECONDS: Final = 6 * 3600

RENDER_SUBMIT_CONCURRENCY: Final = 2

# httpx 的超时按每一步读写算，不是整个请求的总时长：几十 MB 的工程照样传得完
REQUEST_TIMEOUT_SECONDS: Final = 10.0

EXPORT_CONTENT_TYPE: Final = "video/mp4"

CANCELLED: Final = "CANCELLED"

CANCELLED_MESSAGE: Final = "导出已取消"

FINAL_CUT_EMPTY: Final = "FINAL_CUT_EMPTY"

FINAL_CUT_EMPTY_MESSAGE: Final = "final-cut 暂无内容，无法导出"

RenderStatus = Literal["queued", "rendering", "uploading", "done", "failed", "cancelled"]

RenderStage = Literal["queued", "rendering", "uploading"]

RENDER_STAGES: Final[tuple[RenderStage, ...]] = ("queued", "rendering", "uploading")


class RenderUnavailable(Exception):
    pass


class RenderRejected(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class ProjectUnavailable(Exception):
    """读不到对话工作区里的 final-cut 工程（工作区所在的服务连不上）。"""


@dataclass(frozen=True, slots=True)
class ProjectFile:
    """final-cut 工程的一个文件，路径相对工程根（主文件是 ``index.html``）。"""

    path: str
    content: str


ReadProject = Callable[[uuid.UUID, uuid.UUID], Awaitable[Sequence[ProjectFile]]]
"""按属主、对话读这段对话 final-cut 工程里的全部文件；读不到工作区抛 ``ProjectUnavailable``。"""


class _CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="ignore")


class RenderProblem(_CamelModel):
    code: str
    message: str


class RenderExport(_CamelModel):
    id: uuid.UUID
    status: RenderStatus
    progress: float
    queue_position: int | None
    error: RenderProblem | None


class RenderClient:
    def __init__(self, base_url: str, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._client = httpx.AsyncClient(
            base_url=base_url, timeout=REQUEST_TIMEOUT_SECONDS, transport=transport
        )

    async def submit(self, payload: Mapping[str, Any]) -> None:
        """交一次导出；渲染服务不收（400）抛 ``RenderRejected``。"""

        response = await self._send("POST", "/exports", json=payload)
        if response.status_code == 202:
            return
        if response.status_code == 400:
            problem = _parse(RenderProblem, response)
            _logger.info("渲染服务不收这次导出", code=problem.code, message=problem.message)
            raise RenderRejected(problem.code, problem.message)
        raise _unexpected(response)

    async def get(self, export_id: uuid.UUID) -> RenderExport | None:
        response = await self._send("GET", f"/exports/{export_id}")
        if response.status_code == 404:
            return None
        if response.status_code != 200:
            raise _unexpected(response)
        return _parse(RenderExport, response)

    async def cancel(self, export_id: uuid.UUID) -> bool:
        response = await self._send("DELETE", f"/exports/{export_id}")
        if response.status_code == 404:
            return False
        if response.status_code != 204:
            raise _unexpected(response)
        return True

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _send(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        try:
            return await self._client.request(method, path, **kwargs)
        except httpx.HTTPError as exc:
            _logger.warning("渲染服务连不上", method=method, path=path, error=str(exc))
            raise RenderUnavailable("渲染服务连不上，稍后再试") from exc


def _parse[ModelT: BaseModel](model: type[ModelT], response: httpx.Response) -> ModelT:
    try:
        return model.model_validate_json(response.content)
    except ValidationError as exc:
        _logger.warning(
            "渲染服务的答复看不懂", status=response.status_code, body=response.text[:500]
        )
        raise RenderUnavailable("渲染服务的答复看不懂") from exc


def _unexpected(response: httpx.Response) -> RenderUnavailable:
    _logger.warning("渲染服务答复异常", status=response.status_code, body=response.text[:500])
    return RenderUnavailable(f"渲染服务出错了（{response.status_code}），稍后再试")


@dataclass(frozen=True, slots=True)
class RenderSetup:
    client: RenderClient
    uploads: ServerUploadSigner
    public_url: Callable[[str], str]
    read_project: ReadProject


class RenderProvider:
    def __init__(self, setup: RenderSetup, *, fetch_url: Callable[[str], str]) -> None:
        self._client = setup.client
        self._uploads = setup.uploads
        self._public_url = setup.public_url
        self._read_project = setup.read_project
        self._fetch_url = fetch_url

    @property
    def name(self) -> str:
        return PROVIDER_NAME

    async def submit(self, job: GenerationJob) -> ProviderSubmission:
        """把这段对话 final-cut 工程此刻的样子交给渲染服务：全部文件、主文件里每个素材地址的下载
        地址、导出哪种语言（``locale``，原文是 null）、导出分辨率档位（``resolution``，按画面尺寸导出是
        null）和成片的上传签名。"""

        request = request_of(job, WholeFilmRequest, provider=PROVIDER_NAME)
        if job.conversation_id is None:
            raise ProviderError(
                "成片导出记录没有对话",
                code="PROVIDER_CONVERSATION_MISSING",
                retryable=False,
            )
        try:
            files = await self._read_project(job.owner_user_id, job.conversation_id)
        except ProjectUnavailable as exc:
            raise ProviderError(str(exc), code="WORKSPACE_UNAVAILABLE", retryable=True) from exc
        main = next((file.content for file in files if file.path == MAIN_FILE), None)
        if main is None:
            raise ProviderError(FINAL_CUT_EMPTY_MESSAGE, code=FINAL_CUT_EMPTY, retryable=False)
        upload = self._uploads.sign_server_upload(
            object_key=MEDIA_PATHS.whole_film(job_id=job.id),
            content_type=EXPORT_CONTENT_TYPE,
            expires_seconds=RENDER_TIMEOUT_SECONDS,
        )
        payload = {
            "id": str(job.id),
            "conversationId": str(job.conversation_id),
            "files": [{"path": file.path, "content": file.content} for file in files],
            "media": {
                address.url: {"url": self._fetch_url(address.url)}
                for address in media_addresses(main)
            },
            "locale": request.locale,
            "resolution": request.resolution,
            "upload": {"url": upload.url, "headers": dict(upload.headers)},
        }
        try:
            await self._client.submit(payload)
        except RenderRejected as exc:
            raise ProviderError(str(exc), code="RENDER_REJECTED", retryable=False) from exc
        except RenderUnavailable as exc:
            raise ProviderError(str(exc), code="RENDER_UNAVAILABLE", retryable=True) from exc
        return ProviderSubmission(provider_task_id=str(job.id), provider_status="queued")

    async def poll(self, job: GenerationJob) -> ProviderProgress:
        try:
            found = await self._client.get(job.id)
        except RenderUnavailable as exc:
            raise ProviderError(str(exc), code="RENDER_UNAVAILABLE", retryable=True) from exc
        if found is None:
            return ProviderProgress(
                outcome="failed",
                provider_status="lost",
                error_code="RENDER_LOST",
                error_message="渲染服务重启过，这次导出丢了，请重新导出",
            )
        if found.status in RENDER_STAGES:
            return ProviderProgress(outcome="running", provider_status=found.status)
        if found.status == "done":
            return ProviderProgress(
                outcome="succeeded",
                provider_status=found.status,
                output_url=self._public_url(MEDIA_PATHS.whole_film(job_id=job.id)),
            )
        if found.status == "cancelled":
            return ProviderProgress(
                outcome="failed",
                provider_status=found.status,
                error_code=CANCELLED,
                error_message=CANCELLED_MESSAGE,
            )
        return ProviderProgress(
            outcome="failed",
            provider_status=found.status,
            error_code=None if found.error is None else found.error.code,
            error_message=None if found.error is None else found.error.message,
        )


__all__ = [
    "CANCELLED",
    "CANCELLED_MESSAGE",
    "EXPORT_CONTENT_TYPE",
    "FINAL_CUT_EMPTY",
    "FINAL_CUT_EMPTY_MESSAGE",
    "PROVIDER_NAME",
    "RENDER_STAGES",
    "RENDER_SUBMIT_CONCURRENCY",
    "RENDER_TIMEOUT_SECONDS",
    "REQUEST_TIMEOUT_SECONDS",
    "ProjectFile",
    "ProjectUnavailable",
    "ReadProject",
    "RenderClient",
    "RenderExport",
    "RenderProblem",
    "RenderProvider",
    "RenderRejected",
    "RenderSetup",
    "RenderStage",
    "RenderStatus",
    "RenderUnavailable",
]
