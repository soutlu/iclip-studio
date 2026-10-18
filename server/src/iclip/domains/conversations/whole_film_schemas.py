"""整片草稿的 wire 形状与文档规则。

文档的字段名就是前端编辑器与渲染服务读写的那份 JSON，时间一律是整数毫秒。这里只判文档自身的
形状与时间线规则；片段出自哪条记录、合不合格由用例经端口核对，组件名不对照组件库（渲染服务判）。
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Final, Literal

from pydantic import AfterValidator, Field, FiniteFloat, StringConstraints, model_validator

from iclip.domains.conversations.models import WholeFilmExport, WholeFilmExportStatus
from iclip.domains.conversations.schemas import CamelModel

MIN_CLIP_MS: Final = 100
"""画面轨每段、每个特效块至少这么长。"""
MAX_FILM_MS: Final = 120_000
"""整片（画面轨首尾相接的总长）至多两分钟，特效块也不能在这之后结束。"""
MAX_LAYER0_CLIPS: Final = MAX_FILM_MS // MIN_CLIP_MS
"""防大包的上限：两分钟按最短时长排满的段数，正常编辑用不到。"""
MAX_OVERLAYS: Final = MAX_FILM_MS // MIN_CLIP_MS
MAX_CAPTION_EDITS: Final = 1000
MAX_CAPTION_TEXT_CHARS: Final = 500
MAX_CLIP_ID_CHARS: Final = 64
MAX_COMPONENT_CHARS: Final = 200
MAX_VARIABLES: Final = 50
MAX_VARIABLE_NAME_CHARS: Final = 64
MAX_VARIABLE_TEXT_CHARS: Final = 500
MAX_VOLUME: Final = 3.981072
"""音量是倍数：1 是原声，0 是静音；上限 +12 dB，同 HyperFrames 的 audioGain。"""
MAX_CANVAS_EDGE: Final = 4096


def _not_blank(value: str) -> str:
    if not value.strip():
        raise ValueError("不能是空白")
    return value


ClipId = Annotated[
    str, StringConstraints(min_length=1, max_length=MAX_CLIP_ID_CHARS), AfterValidator(_not_blank)
]
ComponentName = Annotated[
    str,
    StringConstraints(min_length=1, max_length=MAX_COMPONENT_CHARS),
    AfterValidator(_not_blank),
]
VariableName = Annotated[
    str,
    StringConstraints(min_length=1, max_length=MAX_VARIABLE_NAME_CHARS),
    AfterValidator(_not_blank),
]
VariableValue = bool | int | FiniteFloat | Annotated[str, Field(max_length=MAX_VARIABLE_TEXT_CHARS)]
Variables = Annotated[dict[VariableName, VariableValue], Field(max_length=MAX_VARIABLES)]
"""组件的可填项，原样交给组件；不对照组件的声明。"""

Ms = Annotated[int, Field(ge=0)]
Index = Annotated[int, Field(ge=0)]
ClipMs = Annotated[int, Field(ge=MIN_CLIP_MS)]
Volume = Annotated[FiniteFloat, Field(ge=0, le=MAX_VOLUME)]


class WholeFilmCanvas(CamelModel):
    width: Annotated[int, Field(ge=1, le=MAX_CANVAS_EDGE)]
    height: Annotated[int, Field(ge=1, le=MAX_CANVAS_EDGE)]


class WholeFilmVideoClip(CamelModel):
    """画面轨上的一段成片：取它自己媒体时间里从 ``playbackStart`` 起的 ``duration``。"""

    id: ClipId
    type: Literal["video"]
    start: Ms
    duration: ClipMs
    playback_start: Ms
    source_job_id: uuid.UUID
    volume: Volume


class WholeFilmComponentClip(CamelModel):
    """画面轨上的一段组件，与视频段同等占时间；从组件自己时间里的 ``playbackStart`` 起播。"""

    id: ClipId
    type: Literal["component"]
    start: Ms
    duration: ClipMs
    playback_start: Ms
    component: ComponentName
    variables: Variables


WholeFilmClip = Annotated[WholeFilmVideoClip | WholeFilmComponentClip, Field(discriminator="type")]


class WholeFilmCaptionEdit(CamelModel):
    """用户改过字的一句：第 ``sentenceIndex`` 句（从 0 数）换成 ``text``。"""

    subtitle_job_id: uuid.UUID
    sentence_index: Index
    text: Annotated[
        str,
        StringConstraints(min_length=1, max_length=MAX_CAPTION_TEXT_CHARS),
        AfterValidator(_not_blank),
    ]


class WholeFilmCaptions(CamelModel):
    component: ComponentName
    edits: Annotated[list[WholeFilmCaptionEdit], Field(max_length=MAX_CAPTION_EDITS)]


class WholeFilmMusic(CamelModel):
    """背景音乐铺满整片：``offset`` 是音乐文件里与整片 0 毫秒对齐的那一刻。"""

    job_id: uuid.UUID
    offset: Ms
    volume: Volume


class WholeFilmOverlay(CamelModel):
    """特效轨上的一个组件，按整片时间放在 ``[start, start + duration)``，从组件自己时间里的
    ``playbackStart`` 起播。

    同 HyperFrames：``track`` 只是显示的行，数小的显示在上面，同一行里不重叠；``zIndex`` 是特效块
    之间的叠放次序，大的在上，相同时数组里后面的在上。两者不必一致，渲染只看 ``zIndex``。"""

    id: ClipId
    component: ComponentName
    start: Ms
    duration: ClipMs
    playback_start: Ms
    track: Index
    z_index: Index
    variables: Variables


class WholeFilmDocument(CamelModel):
    """一段对话的整片草稿。"""

    canvas: WholeFilmCanvas | None
    layer0: Annotated[list[WholeFilmClip], Field(max_length=MAX_LAYER0_CLIPS)]
    captions: WholeFilmCaptions
    music: WholeFilmMusic | None
    overlays: Annotated[list[WholeFilmOverlay], Field(max_length=MAX_OVERLAYS)]

    @model_validator(mode="after")
    def _check_timeline(self) -> WholeFilmDocument:
        _check_ids(self)
        _check_layer0(self.layer0)
        _check_caption_edits(self.captions.edits)
        _check_overlays(self.overlays)
        return self

    def total_ms(self) -> int:
        """整片总长：同 HyperFrames，所有轨上内容的最远结束，即画面轨的结尾（各段时长之和）与
        特效块最晚的结尾里大的那个。两者都不超过上限，总长也就不超过。"""

        overlay_end = max(
            (overlay.start + overlay.duration for overlay in self.overlays), default=0
        )
        return max(sum(clip.duration for clip in self.layer0), overlay_end)

    def video_sources(self) -> tuple[uuid.UUID, ...]:
        """画面轨里各段视频出自的成片，去重，按在画面轨里第一次出现的先后。"""

        return tuple(
            dict.fromkeys(
                clip.source_job_id for clip in self.layer0 if isinstance(clip, WholeFilmVideoClip)
            )
        )


def _check_ids(document: WholeFilmDocument) -> None:
    seen: set[str] = set()
    for item in (*document.layer0, *document.overlays):
        if item.id in seen:
            raise ValueError(f"片段 id「{item.id}」重复了，画面轨与特效轨里的 id 不能相同")
        seen.add(item.id)


def _check_layer0(layer0: list[WholeFilmClip]) -> None:
    """画面轨从 0 起、首尾相接，视频段与组件段先后不限，总长不超过上限。"""

    end = 0
    for index, clip in enumerate(layer0):
        if clip.start != end:
            expected = "0" if index == 0 else f"上一段的结尾 {end}"
            raise ValueError(
                f"画面轨第 {index + 1} 段从 {clip.start} 毫秒开始，应当从 {expected} 毫秒开始："
                "画面轨从 0 起、首尾相接"
            )
        end += clip.duration
    if end > MAX_FILM_MS:
        raise ValueError(f"整片 {end} 毫秒，超过了 {MAX_FILM_MS} 毫秒的上限")


def _check_caption_edits(edits: list[WholeFilmCaptionEdit]) -> None:
    seen: set[tuple[uuid.UUID, int]] = set()
    for edit in edits:
        key = (edit.subtitle_job_id, edit.sentence_index)
        if key in seen:
            raise ValueError(
                f"字幕记录 {edit.subtitle_job_id} 第 {edit.sentence_index} 句改了两次，只能留一份"
            )
        seen.add(key)


def _check_overlays(overlays: list[WholeFilmOverlay]) -> None:
    """特效块不在两分钟之后结束，同一行里彼此不重叠；不同行可以重叠，也可以超出画面轨的结尾
    （整片随之变长）。"""

    rows: dict[int, list[WholeFilmOverlay]] = {}
    for overlay in overlays:
        if overlay.start + overlay.duration > MAX_FILM_MS:
            raise ValueError(
                f"特效块「{overlay.id}」到 {overlay.start + overlay.duration} 毫秒结束，"
                f"超过了 {MAX_FILM_MS} 毫秒的上限"
            )
        rows.setdefault(overlay.track, []).append(overlay)
    for row in rows.values():
        previous: WholeFilmOverlay | None = None
        for overlay in sorted(row, key=lambda item: item.start):
            if previous is not None and overlay.start < previous.start + previous.duration:
                raise ValueError(
                    f"特效块「{overlay.id}」与「{previous.id}」在同一行（第 {overlay.track + 1} 行）上重叠了"
                )
            previous = overlay


class WholeFilmDraftIn(CamelModel):
    """整份保存草稿。``revision`` 是读到的那一版，还没有草稿时是 0。"""

    revision: Index
    document: WholeFilmDocument


class WholeFilmDraftOut(CamelModel):
    """当前的草稿；还没存过时 ``revision`` 是 0，``document`` 与 ``updatedAt`` 为 null。"""

    revision: int
    document: WholeFilmDocument | None
    updated_at: datetime | None


class WholeFilmDraftSavedOut(CamelModel):
    """保存后的新版本号与保存时刻。"""

    revision: int
    updated_at: datetime


class WholeFilmExportIn(CamelModel):
    """按当前草稿导出；``revision`` 是页面上那一版，不是服务端存的那一版就不导。"""

    revision: Index


class WholeFilmExportStartedOut(CamelModel):
    """已交给渲染服务排队。``sourceJobIds`` 是这次导出用到的成片，去重、按在画面轨里第一次出现的
    先后；下载时按它们各记一次下载。"""

    export_id: uuid.UUID
    source_job_ids: list[uuid.UUID]


class WholeFilmExportErrorOut(CamelModel):
    code: str
    message: str


class WholeFilmExportOut(CamelModel):
    """一次导出现在的样子。``downloadUrl`` 与 ``expiresAt`` 只在 ``done`` 时有。"""

    status: WholeFilmExportStatus
    progress: float
    queue_position: int | None
    error: WholeFilmExportErrorOut | None
    download_url: str | None
    expires_at: datetime | None


def whole_film_export_out(export: WholeFilmExport) -> WholeFilmExportOut:
    return WholeFilmExportOut(
        status=export.status,
        progress=export.progress,
        queue_position=export.queue_position,
        error=None
        if export.error is None
        else WholeFilmExportErrorOut(code=export.error.code, message=export.error.message),
        download_url=export.download_url,
        expires_at=export.expires_at,
    )


__all__ = [
    "MAX_CANVAS_EDGE",
    "MAX_CAPTION_EDITS",
    "MAX_CAPTION_TEXT_CHARS",
    "MAX_CLIP_ID_CHARS",
    "MAX_COMPONENT_CHARS",
    "MAX_FILM_MS",
    "MAX_LAYER0_CLIPS",
    "MAX_OVERLAYS",
    "MAX_VARIABLES",
    "MAX_VARIABLE_NAME_CHARS",
    "MAX_VARIABLE_TEXT_CHARS",
    "MAX_VOLUME",
    "MIN_CLIP_MS",
    "WholeFilmCanvas",
    "WholeFilmCaptionEdit",
    "WholeFilmCaptions",
    "WholeFilmClip",
    "WholeFilmComponentClip",
    "WholeFilmDocument",
    "WholeFilmDraftIn",
    "WholeFilmDraftOut",
    "WholeFilmDraftSavedOut",
    "WholeFilmExportErrorOut",
    "WholeFilmExportIn",
    "WholeFilmExportOut",
    "WholeFilmExportStartedOut",
    "WholeFilmMusic",
    "WholeFilmOverlay",
    "WholeFilmVideoClip",
    "whole_film_export_out",
]
