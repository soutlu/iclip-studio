"""已有整片记录里存的请求形状（video / compose，没有来源）。现在不能新建整片，这些模型只用来把库里的
请求读回来。"""

from __future__ import annotations

import uuid
from typing import Annotated, ClassVar, Final

from pydantic import Field, field_validator, model_validator

from iclip.common.generation_vocab import GenerationKind, GenerationOperation
from iclip.domains.generation.schemas import (
    KIND_VIDEO,
    OPERATION_COMPOSE,
    CamelModel,
    DownloadUrl,
    nonblank,
)
from iclip.platform.media.fonts import FontStyle

MAX_WHOLE_FILM_MS: Final = 120_000
MAX_WHOLE_FILM_SUBTITLE_CHARS: Final = 200
MAX_MUSIC_GAIN_POINTS: Final = 500

SPEECH_LOUDNESS_LUFS: Final = -16.0
FILM_LOUDNESS_LUFS: Final = -14.0
FILM_PEAK_DBFS: Final = -1.5
SEGMENT_FADE_MS: Final = 50
MUSIC_FADE_OUT_MS: Final = 2000

FilmMs = Annotated[int, Field(ge=0, le=MAX_WHOLE_FILM_MS)]


class WholeFilmSegment(CamelModel):
    """整片里的一段：从 ``sourceJobId`` 那条成片上取 ``[startMs, endMs)``，按那条成片自己的媒体时间。"""

    source_job_id: uuid.UUID
    url: DownloadUrl
    start_ms: Annotated[int, Field(ge=0)]
    end_ms: int
    volume: Annotated[float, Field(ge=0, le=2)] = 1.0

    @model_validator(mode="after")
    def _end_after_start(self) -> WholeFilmSegment:
        if self.end_ms <= self.start_ms:
            raise ValueError("endMs 必须大于 startMs")
        return self


class WholeFilmSubtitle(CamelModel):
    """整片上的一句字幕：整片时间里的起止（毫秒）与烧进画面的文字。"""

    start_ms: FilmMs
    end_ms: FilmMs
    text: Annotated[str, Field(min_length=1, max_length=MAX_WHOLE_FILM_SUBTITLE_CHARS)]

    _check_text = field_validator("text")(nonblank)

    @model_validator(mode="after")
    def _end_after_start(self) -> WholeFilmSubtitle:
        if self.end_ms <= self.start_ms:
            raise ValueError("endMs 必须大于 startMs")
        return self


class MusicGainPoint(CamelModel):
    """音量曲线上的一个点：整片时间 ``atMs`` 处音乐的线性音量（0 静音，1 原样）。"""

    at_ms: FilmMs
    gain: Annotated[float, Field(ge=0, le=1)]


class WholeFilmMusic(CamelModel):
    """整片的背景音乐：用哪条音频记录、从它第几毫秒起用，以及整片时间上的音量曲线。"""

    audio_job_id: uuid.UUID
    url: DownloadUrl
    offset_ms: Annotated[int, Field(ge=0)]
    volume: Annotated[float, Field(ge=0, le=2)] = 1.0
    gain: Annotated[list[MusicGainPoint], Field(min_length=1, max_length=MAX_MUSIC_GAIN_POINTS)]

    @field_validator("gain")
    @classmethod
    def _strictly_increasing(cls, points: list[MusicGainPoint]) -> list[MusicGainPoint]:
        for position in range(1, len(points)):
            if points[position].at_ms <= points[position - 1].at_ms:
                raise ValueError(
                    f"第 {position + 1} 个点的 atMs {points[position].at_ms} 不晚于前一个点"
                )
        return points


class WholeFilmBrand(CamelModel):
    template_id: uuid.UUID
    url: DownloadUrl
    duration_ms: Annotated[int, Field(gt=0)]
    width: Annotated[int, Field(gt=0)]
    height: Annotated[int, Field(gt=0)]
    has_audio: bool


class WholeFilmFont(CamelModel):
    font_id: uuid.UUID
    url: DownloadUrl
    name: Annotated[str, Field(min_length=1)]
    family: Annotated[str, Field(min_length=1)]
    weight: Annotated[int, Field(ge=1, le=1000)]
    style: FontStyle


class WholeFilmRender(CamelModel):
    speech_loudness_lufs: float = SPEECH_LOUDNESS_LUFS
    music_loudness_lufs: float = SPEECH_LOUDNESS_LUFS
    loudness_lufs: float = FILM_LOUDNESS_LUFS
    peak_dbfs: float = FILM_PEAK_DBFS
    segment_fade_ms: Annotated[int, Field(ge=0)] = SEGMENT_FADE_MS
    music_fade_out_ms: Annotated[int, Field(ge=0)] = MUSIC_FADE_OUT_MS


class WholeFilmRequest(CamelModel):
    kind: ClassVar[GenerationKind] = KIND_VIDEO
    operation: ClassVar[GenerationOperation] = OPERATION_COMPOSE

    segments: Annotated[list[WholeFilmSegment], Field(min_length=1)]
    subtitles: list[WholeFilmSubtitle]
    music: WholeFilmMusic | None
    render: WholeFilmRender
    font: WholeFilmFont | None
    intro: WholeFilmBrand | None
    outro: WholeFilmBrand | None


__all__ = [
    "MusicGainPoint",
    "WholeFilmBrand",
    "WholeFilmFont",
    "WholeFilmMusic",
    "WholeFilmRender",
    "WholeFilmRequest",
    "WholeFilmSegment",
    "WholeFilmSubtitle",
]
