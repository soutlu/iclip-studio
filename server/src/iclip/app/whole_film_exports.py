"""整片导出的组合根适配：渲染服务的内网 HTTP 客户端，以及把草稿换成一次渲染请求。

接口形状见渲染服务的内部接口约定（POST / GET / DELETE ``/exports``）。导出状态只在渲染服务内存里，
本系统不落库；成片与音乐换成渲染服务取得到的地址（本桶对象走内网），上传地址签给内网，下载
地址签给浏览器。"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Mapping
from datetime import UTC, datetime, timedelta, timezone
from typing import Any, Final, Literal

import httpx
import structlog
from pydantic import BaseModel, ConfigDict, ValidationError
from pydantic.alias_generators import to_camel

from iclip.common.errors import ValidationFailed
from iclip.domains.conversations.models import WholeFilmExport, WholeFilmExportError
from iclip.domains.conversations.service import WholeFilmRenderUnavailable
from iclip.domains.conversations.whole_film_schemas import WholeFilmDocument
from iclip.domains.generation.models import STATUS_COMPLETED
from iclip.domains.generation.repository import GenerationRepository
from iclip.domains.generation.schemas import KIND_SUBTITLE
from iclip.platform.object_store.layout import MEDIA_PATHS
from iclip.platform.object_store.store import PrivateObjectSigner

_logger = structlog.stdlib.get_logger(__name__)

RENDER_TIMEOUT_SECONDS: Final = 10.0
"""一次调用渲染服务的上限；它只排队、查内存，不在请求里渲染。"""

UPLOAD_EXPIRES_SECONDS: Final = 6 * 3600
"""上传地址的有效期：渲染服务一次只渲染一个，排在后面的要等前面的都渲染完才上传；短于临时对象
1 天的生命周期。"""

DOWNLOAD_EXPIRES_SECONDS: Final = 3600

FILENAME_ZONE: Final = timezone(timedelta(hours=8), "Asia/Shanghai")
"""下载文件名里的时刻按北京时间写，是签发下载地址的那一刻。用固定偏移：北京时间没有夏令时，
而 slim 镜像里没有时区库，``ZoneInfo`` 在那里起不来。"""

EXPORT_CONTENT_TYPE: Final = "video/mp4"

SUBTITLE_SCAN_LIMIT: Final = 50
"""每条成片往回看几条字幕记录找最新的已完成那条；手动重识别不会多到这个数。"""


class _CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="ignore")


class _RenderProblem(_CamelModel):
    code: str
    message: str


class _RenderExport(_CamelModel):
    id: uuid.UUID
    conversation_id: uuid.UUID
    status: Literal["queued", "rendering", "uploading", "done", "failed", "cancelled"]
    progress: float
    queue_position: int | None
    error: _RenderProblem | None


class WholeFilmRenderClient:
    """渲染服务的内网客户端。连不上、5xx 或答复看不懂抛 ``WholeFilmRenderUnavailable``；它不认
    这份请求（400）抛 ``ValidationFailed``，消息是它给的那句话。"""

    def __init__(self, base_url: str, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._client = httpx.AsyncClient(
            base_url=base_url, timeout=RENDER_TIMEOUT_SECONDS, transport=transport
        )

    async def submit(self, payload: Mapping[str, Any]) -> None:
        response = await self._send("POST", "/exports", json=payload)
        if response.status_code == 202:
            return
        if response.status_code == 400:
            problem = _parse(_RenderProblem, response)
            _logger.info("渲染服务不收这次导出", code=problem.code, message=problem.message)
            raise ValidationFailed(problem.message)
        raise _unexpected(response)

    async def get(self, export_id: uuid.UUID) -> _RenderExport | None:
        response = await self._send("GET", f"/exports/{export_id}")
        if response.status_code == 404:
            return None
        if response.status_code != 200:
            raise _unexpected(response)
        return _parse(_RenderExport, response)

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
            raise WholeFilmRenderUnavailable("渲染服务连不上，稍后再试") from exc


def _parse[ModelT: BaseModel](model: type[ModelT], response: httpx.Response) -> ModelT:
    try:
        return model.model_validate_json(response.content)
    except ValidationError as exc:
        _logger.warning(
            "渲染服务的答复看不懂", status=response.status_code, body=response.text[:500]
        )
        raise WholeFilmRenderUnavailable("渲染服务的答复看不懂") from exc


def _unexpected(response: httpx.Response) -> WholeFilmRenderUnavailable:
    _logger.warning("渲染服务答复异常", status=response.status_code, body=response.text[:500])
    return WholeFilmRenderUnavailable(f"渲染服务出错了（{response.status_code}），稍后再试")


def export_filename(moment: datetime) -> str:
    """下载时的文件名：``整片-<年月日-时分>.mp4``，按 ``FILENAME_ZONE`` 写。"""

    return f"整片-{moment.astimezone(FILENAME_ZONE):%Y%m%d-%H%M}.mp4"


class WholeFilmExportAdapter:
    """对话域 ``WholeFilmExports`` 的实现。

    ``fetch_url`` 把本桶对象的公网地址换成内网地址（没配内网 endpoint 时原样）；上游发布的出片地址
    原样交给渲染服务，它的主机要在渲染服务的允许列表里。"""

    def __init__(
        self,
        *,
        render: WholeFilmRenderClient,
        generations: GenerationRepository,
        signer: PrivateObjectSigner,
        fetch_url: Callable[[str], str],
    ) -> None:
        self._render = render
        self._generations = generations
        self._signer = signer
        self._fetch_url = fetch_url

    async def start(
        self, *, export_id: uuid.UUID, conversation_id: uuid.UUID, document: WholeFilmDocument
    ) -> None:
        sources = document.video_sources()
        music_id = None if document.music is None else document.music.job_id
        wanted = {*sources, *(() if music_id is None else (music_id,))}
        urls = await self._generations.output_urls(wanted)
        for job_id in wanted:
            if job_id not in urls:
                raise ValidationFailed(f"记录 {job_id} 没有产物地址，导不出整片")
        upload = self._signer.sign_private_put(
            object_key=MEDIA_PATHS.whole_film_export(export_id=export_id),
            content_type=EXPORT_CONTENT_TYPE,
            expires_seconds=UPLOAD_EXPIRES_SECONDS,
        )
        await self._render.submit(
            {
                "id": str(export_id),
                "conversationId": str(conversation_id),
                "document": document.model_dump(mode="json", by_alias=True),
                "media": {
                    "videos": {
                        str(source): {"url": self._fetch_url(urls[source])} for source in sources
                    },
                    "music": None if music_id is None else {"url": self._fetch_url(urls[music_id])},
                    "subtitles": await self._subtitles(sources),
                },
                "upload": {"url": upload.url, "headers": dict(upload.headers)},
            }
        )

    async def _subtitles(self, sources: tuple[uuid.UUID, ...]) -> dict[str, Any]:
        """每条成片最新的一条已完成字幕记录（含逐词时间）；一条都没有的成片不在里面。

        不看属主：出处已在存草稿时核过是这段对话读得到的成片，它的字幕跟着读。"""

        found: dict[str, Any] = {}
        for source in sources:
            records = await self._generations.list_for_owner(
                owner=None, limit=SUBTITLE_SCAN_LIMIT, kind=KIND_SUBTITLE, source_job_id=source
            )
            latest = next(
                (
                    record
                    for record in records
                    if record.status == STATUS_COMPLETED and record.sentences is not None
                ),
                None,
            )
            if latest is not None and latest.sentences is not None:
                found[str(source)] = {
                    "subtitleJobId": str(latest.id),
                    "sentences": [
                        sentence.model_dump(mode="json", by_alias=True)
                        for sentence in latest.sentences
                    ],
                }
        return found

    async def get(self, export_id: uuid.UUID) -> WholeFilmExport | None:
        found = await self._render.get(export_id)
        if found is None:
            return None
        download_url: str | None = None
        expires_at: datetime | None = None
        if found.status == "done":
            now = datetime.now(UTC)
            download_url = self._signer.sign_download(
                object_key=MEDIA_PATHS.whole_film_export(export_id=export_id),
                filename=export_filename(now),
                expires_seconds=DOWNLOAD_EXPIRES_SECONDS,
            )
            expires_at = now + timedelta(seconds=DOWNLOAD_EXPIRES_SECONDS)
        return WholeFilmExport(
            conversation_id=found.conversation_id,
            status=found.status,
            progress=found.progress,
            queue_position=found.queue_position,
            error=None
            if found.error is None
            else WholeFilmExportError(code=found.error.code, message=found.error.message),
            download_url=download_url,
            expires_at=expires_at,
        )

    async def cancel(self, export_id: uuid.UUID) -> bool:
        return await self._render.cancel(export_id)


__all__ = [
    "DOWNLOAD_EXPIRES_SECONDS",
    "FILENAME_ZONE",
    "UPLOAD_EXPIRES_SECONDS",
    "WholeFilmExportAdapter",
    "WholeFilmRenderClient",
    "export_filename",
]
