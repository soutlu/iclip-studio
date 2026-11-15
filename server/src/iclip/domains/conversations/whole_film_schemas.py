from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated

from pydantic import Field

from iclip.domains.conversations.models import WholeFilmExport, WholeFilmExportStatus
from iclip.domains.conversations.schemas import CamelModel


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


class FinalCutPreviewOut(CamelModel):
    """预览令牌。预览页的地址由前端拼成 ``<origin>/api/final-cut/preview/<token>/…``。"""

    origin: str
    token: str
    expires_at: datetime


class FinalCutPreviewHostOut(CamelModel):
    """发令牌时请求的 ``Origin``：预览页只接受来自这个来源的消息。"""

    app_origin: str


class FinalCutFileIn(CamelModel):
    """在成片工程里新建一个文件。``path`` 相对工程根，如 ``index.html``。"""

    path: Annotated[str, Field(min_length=1)]
    content: str


class FinalCutFileCreatedOut(CamelModel):
    """新建的文件：``path`` 与请求里的相同（相对工程根），工作区里的路径是 ``final-cut/`` 加上它；
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
    "FinalCutFileCreatedOut",
    "FinalCutFileIn",
    "FinalCutPreviewHostOut",
    "FinalCutPreviewOut",
    "WholeFilmExportErrorOut",
    "WholeFilmExportLatestOut",
    "WholeFilmExportOut",
    "whole_film_export_out",
]
