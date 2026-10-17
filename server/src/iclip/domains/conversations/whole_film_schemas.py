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
"""画面轨每段、每个转场、每层包装至少这么长。"""
MAX_FILM_MS: Final = 120_000
"""整片（画面轨首尾相接的总长）至多两分钟。"""
MAX_VIDEO_CLIPS: Final = 100
"""画面轨里视频片段的上限；片头片尾另算。"""
MAX_LAYER0_CLIPS: Final = MAX_VIDEO_CLIPS + 2
MAX_TRANSITIONS: Final = MAX_LAYER0_CLIPS - 1
MAX_OVERLAYS: Final = 50
MAX_CAPTION_EDITS: Final = 1000
MAX_CAPTION_TEXT_CHARS: Final = 500
MAX_CLIP_ID_CHARS: Final = 64
MAX_COMPONENT_CHARS: Final = 200
MAX_VARIABLES: Final = 50
MAX_VARIABLE_NAME_CHARS: Final = 64
MAX_VARIABLE_TEXT_CHARS: Final = 500
MAX_VOLUME: Final = 2
"""音量是倍数：1 是原声，0 是静音。"""
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
    """画面轨上的片头或片尾，是组件库里的一个组件。"""

    id: ClipId
    type: Literal["component"]
    role: Literal["intro", "outro"]
    start: Ms
    duration: ClipMs
    component: ComponentName
    variables: Variables


WholeFilmClip = Annotated[WholeFilmVideoClip | WholeFilmComponentClip, Field(discriminator="type")]


class WholeFilmTransition(CamelModel):
    """``afterClipId`` 那一段与下一段之间的转场。"""

    id: ClipId
    after_clip_id: ClipId
    component: ComponentName
    duration: ClipMs
    variables: Variables


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
    """包装层上的一个组件，按整片时间放在 ``[start, start + duration)``。"""

    id: ClipId
    component: ComponentName
    start: Ms
    duration: ClipMs
    variables: Variables


class WholeFilmDocument(CamelModel):
    """一段对话的整片草稿。"""

    canvas: WholeFilmCanvas | None
    layer0: Annotated[list[WholeFilmClip], Field(max_length=MAX_LAYER0_CLIPS)]
    transitions: Annotated[list[WholeFilmTransition], Field(max_length=MAX_TRANSITIONS)]
    captions: WholeFilmCaptions
    music: WholeFilmMusic | None
    overlays: Annotated[list[WholeFilmOverlay], Field(max_length=MAX_OVERLAYS)]

    @model_validator(mode="after")
    def _check_timeline(self) -> WholeFilmDocument:
        _check_ids(self)
        total = _check_layer0(self.layer0)
        _check_transitions(self.transitions, self.layer0)
        _check_caption_edits(self.captions.edits)
        _check_overlays(self.overlays, total)
        return self

    def total_ms(self) -> int:
        """整片总长：画面轨首尾相接，就是各段时长之和。"""

        return sum(clip.duration for clip in self.layer0)

    def video_sources(self) -> tuple[uuid.UUID, ...]:
        """画面轨里各段视频出自的成片，去重，按在画面轨里第一次出现的先后。"""

        return tuple(
            dict.fromkeys(
                clip.source_job_id for clip in self.layer0 if isinstance(clip, WholeFilmVideoClip)
            )
        )


def _check_ids(document: WholeFilmDocument) -> None:
    seen: set[str] = set()
    for item in (*document.layer0, *document.transitions, *document.overlays):
        if item.id in seen:
            raise ValueError(f"片段 id「{item.id}」重复了，画面、转场与包装里的 id 不能相同")
        seen.add(item.id)


def _check_layer0(layer0: list[WholeFilmClip]) -> int:
    """画面轨从 0 起、首尾相接；片头只在第一段、片尾只在最后一段，各至多一个。返回总长。"""

    videos = sum(1 for clip in layer0 if isinstance(clip, WholeFilmVideoClip))
    if videos > MAX_VIDEO_CLIPS:
        raise ValueError(f"画面轨至多 {MAX_VIDEO_CLIPS} 段视频，现在有 {videos} 段")
    end = 0
    for index, clip in enumerate(layer0):
        if clip.start != end:
            expected = "0" if index == 0 else f"上一段的结尾 {end}"
            raise ValueError(
                f"画面轨第 {index + 1} 段从 {clip.start} 毫秒开始，应当从 {expected} 毫秒开始："
                "画面轨从 0 起、首尾相接"
            )
        if isinstance(clip, WholeFilmComponentClip):
            if clip.role == "intro" and index != 0:
                raise ValueError(f"片头只能放在画面轨第一段，现在在第 {index + 1} 段")
            if clip.role == "outro" and index != len(layer0) - 1:
                raise ValueError(f"片尾只能放在画面轨最后一段，现在在第 {index + 1} 段")
        end += clip.duration
    if end > MAX_FILM_MS:
        raise ValueError(f"整片 {end} 毫秒，超过了 {MAX_FILM_MS} 毫秒的上限")
    return end


def _check_transitions(transitions: list[WholeFilmTransition], layer0: list[WholeFilmClip]) -> None:
    """转场接在画面轨的某一段后面，那一段不能是最后一段；一段后面至多一个转场。"""

    joinable = {clip.id for clip in layer0[:-1]}
    taken: set[str] = set()
    for transition in transitions:
        if transition.after_clip_id not in joinable:
            raise ValueError(
                f"转场「{transition.id}」接在「{transition.after_clip_id}」后面，"
                "那得是画面轨里一段、且不是最后一段"
            )
        if transition.after_clip_id in taken:
            raise ValueError(f"画面轨「{transition.after_clip_id}」后面只能有一个转场")
        taken.add(transition.after_clip_id)


def _check_caption_edits(edits: list[WholeFilmCaptionEdit]) -> None:
    seen: set[tuple[uuid.UUID, int]] = set()
    for edit in edits:
        key = (edit.subtitle_job_id, edit.sentence_index)
        if key in seen:
            raise ValueError(
                f"字幕记录 {edit.subtitle_job_id} 第 {edit.sentence_index} 句改了两次，只能留一份"
            )
        seen.add(key)


def _check_overlays(overlays: list[WholeFilmOverlay], total: int) -> None:
    """包装都在整片之内，彼此不重叠；数组里的先后不限。"""

    previous: WholeFilmOverlay | None = None
    for overlay in sorted(overlays, key=lambda item: item.start):
        if overlay.start + overlay.duration > total:
            raise ValueError(
                f"包装「{overlay.id}」到 {overlay.start + overlay.duration} 毫秒结束，"
                f"超出了整片的 {total} 毫秒"
            )
        if previous is not None and overlay.start < previous.start + previous.duration:
            raise ValueError(f"包装「{overlay.id}」与「{previous.id}」重叠了")
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
    "MAX_TRANSITIONS",
    "MAX_VARIABLES",
    "MAX_VARIABLE_NAME_CHARS",
    "MAX_VARIABLE_TEXT_CHARS",
    "MAX_VIDEO_CLIPS",
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
    "WholeFilmTransition",
    "WholeFilmVideoClip",
    "whole_film_export_out",
]
