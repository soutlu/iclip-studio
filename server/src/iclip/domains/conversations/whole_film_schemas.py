from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Final

from pydantic import Field, StringConstraints

from iclip.domains.conversations.models import WholeFilmExport, WholeFilmExportStatus
from iclip.domains.conversations.schemas import CamelModel

MAX_FILM_CHARS: Final = 1_000_000

Index = Annotated[int, Field(ge=0)]
FilmHtml = Annotated[str, StringConstraints(min_length=1, max_length=MAX_FILM_CHARS)]


class WholeFilmDraftIn(CamelModel):
    """整份保存成片文件。``revision`` 是读到的那一版，还没有草稿时是 0。"""

    revision: Index
    html: FilmHtml


class WholeFilmDraftOut(CamelModel):
    """当前的成片文件；还没存过时 ``revision`` 是 0，``html`` 与 ``updatedAt`` 为 null。"""

    revision: int
    html: str | None
    updated_at: datetime | None


class WholeFilmDraftSavedOut(CamelModel):
    """保存后的新版本号与保存时刻。"""

    revision: int
    updated_at: datetime


class WholeFilmExportIn(CamelModel):
    """按当前草稿导出；``revision`` 是页面上那一版，不是服务端存的那一版就不导。"""

    revision: Index


class WholeFilmExportStartedOut(CamelModel):
    """已受理、排进导出队列。``exportId`` 是这次导出那条生成记录的 id。"""

    export_id: uuid.UUID


class WholeFilmExportErrorOut(CamelModel):
    code: str
    message: str


class WholeFilmExportOut(CamelModel):
    """一次导出现在的样子。``downloadUrl`` 只在 ``done`` 时有，``error`` 只在 ``failed`` 时有。"""

    id: uuid.UUID
    status: WholeFilmExportStatus
    progress: float | None
    queue_position: int | None
    error: WholeFilmExportErrorOut | None
    download_url: str | None


class WholeFilmExportLatestOut(CamelModel):
    """这段对话最新的一次导出；还没导出过为 null。"""

    export: WholeFilmExportOut | None


class WholeFilmPreviewOut(CamelModel):
    """预览令牌。预览页的地址由前端拼成 ``<origin>/api/whole-film/preview/<token>/…``。"""

    origin: str
    token: str
    expires_at: datetime


class WholeFilmPreviewHostOut(CamelModel):
    """发令牌时请求的 ``Origin``：预览页只接受来自这个来源的消息。"""

    app_origin: str


class WholeFilmFileIn(CamelModel):
    """在成片工程里新建一个文件。``path`` 相对工程根，如 ``index.html``。"""

    path: Annotated[str, Field(min_length=1)]
    content: str


class WholeFilmFileCreatedOut(CamelModel):
    """新建的文件：``path`` 与请求里的相同（相对工程根），工作区里的路径是 ``whole-film/`` 加上它；
    ``version`` 是工作区文件的版本号，之后用 ``PUT /conversations/{id}/workspace/file`` 修改。"""

    path: str
    version: int


def whole_film_export_out(export: WholeFilmExport) -> WholeFilmExportOut:
    return WholeFilmExportOut(
        id=export.id,
        status=export.status,
        progress=export.progress,
        queue_position=export.queue_position,
        error=None
        if export.error is None
        else WholeFilmExportErrorOut(code=export.error.code, message=export.error.message),
        download_url=export.download_url,
    )


__all__ = [
    "MAX_FILM_CHARS",
    "WholeFilmDraftIn",
    "WholeFilmDraftOut",
    "WholeFilmDraftSavedOut",
    "WholeFilmExportErrorOut",
    "WholeFilmExportIn",
    "WholeFilmExportLatestOut",
    "WholeFilmExportOut",
    "WholeFilmExportStartedOut",
    "WholeFilmFileCreatedOut",
    "WholeFilmFileIn",
    "WholeFilmPreviewHostOut",
    "WholeFilmPreviewOut",
    "whole_film_export_out",
]
