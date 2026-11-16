from __future__ import annotations

import uuid
from collections.abc import Sequence
from datetime import datetime
from typing import Annotated, Literal

from pydantic import Field, field_validator

from iclip.domains.conversations.final_cut_translation import (
    MAX_TRANSLATION_ENTRIES,
    MAX_TRANSLATION_ID_CHARS,
    MAX_TRANSLATION_TEXT_CHARS,
    MAX_TRANSLATION_TOTAL_CHARS,
    FinalCutText,
    TargetLocale,
)
from iclip.domains.conversations.models import WholeFilmExport, WholeFilmExportStatus
from iclip.domains.conversations.schemas import CamelModel


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


class FinalCutPreviewOut(CamelModel):
    """预览令牌。预览页的地址由前端拼成 ``<origin>/api/final-cut/preview/<token>/…``。"""

    origin: str
    token: str
    expires_at: datetime


class FinalCutPreviewHostOut(CamelModel):
    """发令牌时请求的 ``Origin``：预览页只接受来自这个来源的消息。"""

    app_origin: str


class FinalCutFileIn(CamelModel):
    """在 final-cut 工程里新建一个文件。``path`` 相对工程根，如 ``index.html``。"""

    path: Annotated[str, Field(min_length=1)]
    content: str


class FinalCutFileCreatedOut(CamelModel):
    """新建的文件：``path`` 与请求里的相同（相对工程根），工作区里的路径是 ``final-cut/`` 加上它；
    ``version`` 是工作区文件的版本号，之后用 ``PUT /conversations/{id}/workspace/file`` 修改。"""

    path: str
    version: int


class FinalCutTextIn(CamelModel):
    """一条要翻的中文：``id`` 是编辑器里变量的 id，``text`` 不能只有空白。"""

    id: Annotated[str, Field(min_length=1, max_length=MAX_TRANSLATION_ID_CHARS)]
    text: Annotated[str, Field(min_length=1, max_length=MAX_TRANSLATION_TEXT_CHARS)]

    @field_validator("text")
    @classmethod
    def _not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("不能只有空白")
        return value


class FinalCutTranslationsIn(CamelModel):
    """把一批中文短句翻成 ``targetLocale``。源语言固定是中文；``entries`` 里的 ``id`` 不能重复。"""

    target_locale: TargetLocale
    entries: Annotated[
        list[FinalCutTextIn],
        Field(
            min_length=1,
            max_length=MAX_TRANSLATION_ENTRIES,
            description=f"所有 text 加起来最多 {MAX_TRANSLATION_TOTAL_CHARS} 字，超了要分批发",
        ),
    ]

    @field_validator("entries")
    @classmethod
    def _unique_ids(cls, value: list[FinalCutTextIn]) -> list[FinalCutTextIn]:
        seen: set[str] = set()
        for entry in value:
            if entry.id in seen:
                raise ValueError(f"id {entry.id!r} 重复")
            seen.add(entry.id)
        return value

    @field_validator("entries")
    @classmethod
    def _fits_one_call(cls, value: list[FinalCutTextIn]) -> list[FinalCutTextIn]:
        total = sum(len(entry.text) for entry in value)
        if total > MAX_TRANSLATION_TOTAL_CHARS:
            raise ValueError(
                f"一批最多 {MAX_TRANSLATION_TOTAL_CHARS} 字，这一批有 {total} 字，请分批翻译"
            )
        return value

    def texts(self) -> tuple[FinalCutText, ...]:
        return tuple(FinalCutText(id=entry.id, text=entry.text) for entry in self.entries)


class FinalCutTranslationOut(CamelModel):
    id: str
    text: str


class FinalCutTranslationsOut(CamelModel):
    """译文：请求里的每个 ``id`` 恰好一条，顺序同请求。"""

    translations: list[FinalCutTranslationOut]


class FinalCutTranslationErrorOut(CamelModel):
    """翻译失败：``model_unavailable`` 没有启用翻译用的模型（409）；``model_call_failed`` 模型调用
    暂时失败，再试一次可能就好（502）；``model_failed`` 模型拒绝、等待超时或回答不对（502）。"""

    detail: str
    code: Literal["model_unavailable", "model_call_failed", "model_failed"]


def final_cut_translations_out(translated: Sequence[FinalCutText]) -> FinalCutTranslationsOut:
    return FinalCutTranslationsOut(
        translations=[FinalCutTranslationOut(id=one.id, text=one.text) for one in translated]
    )


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
    "FinalCutTextIn",
    "FinalCutTranslationErrorOut",
    "FinalCutTranslationOut",
    "FinalCutTranslationsIn",
    "FinalCutTranslationsOut",
    "WholeFilmExportErrorOut",
    "WholeFilmExportLatestOut",
    "WholeFilmExportOut",
    "WholeFilmExportStartedOut",
    "final_cut_translations_out",
    "whole_film_export_out",
]
