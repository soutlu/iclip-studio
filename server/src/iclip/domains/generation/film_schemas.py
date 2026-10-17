from __future__ import annotations

import uuid
from collections.abc import Sequence
from typing import Annotated, ClassVar, Final, Literal

from pydantic import Field, field_validator, model_validator

from iclip.common.generation_vocab import GenerationKind, GenerationOperation
from iclip.common.shot_prompt import format_seconds
from iclip.domains.generation.schemas import (
    KIND_VIDEO,
    MAX_COMPOSE_SEGMENTS,
    OPERATION_COMPOSE,
    CamelModel,
    DownloadUrl,
    Metadata,
    UserName,
    nonblank,
)

MAX_WHOLE_FILM_MS: Final = 120_000
MAX_WHOLE_FILM_SUBTITLES: Final = 500
MAX_WHOLE_FILM_SUBTITLE_CHARS: Final = 200
# 曲线写进一条 ffmpeg 命令的参数里，Linux 单个参数上限 128 KB；500 个点约 30 KB。
MAX_MUSIC_GAIN_POINTS: Final = 500

SPEECH_LOUDNESS_LUFS: Final = -16.0
FILM_LOUDNESS_LUFS: Final = -14.0
FILM_PEAK_DBFS: Final = -1.5
SEGMENT_FADE_MS: Final = 50
MUSIC_FADE_OUT_MS: Final = 2000

FilmMs = Annotated[int, Field(ge=0, le=MAX_WHOLE_FILM_MS)]


class WholeFilmSegmentIn(CamelModel):
    """整片里的一段：从 ``sourceJobId`` 那条成片上取 ``[startMs, endMs)``，按那条成片自己的媒体时间。"""

    source_job_id: uuid.UUID
    start_ms: Annotated[int, Field(ge=0)]
    end_ms: int
    volume: Annotated[float, Field(ge=0, le=2)] = 1.0

    @model_validator(mode="after")
    def _end_after_start(self) -> WholeFilmSegmentIn:
        if self.end_ms <= self.start_ms:
            raise ValueError("endMs 必须大于 startMs")
        return self

    @property
    def duration_ms(self) -> int:
        return self.end_ms - self.start_ms


def segments_ms(segments: Sequence[WholeFilmSegmentIn]) -> int:
    return sum(segment.duration_ms for segment in segments)


class WholeFilmSubtitle(CamelModel):
    """整片上的一句字幕：整片时间里的起止（毫秒）与烧进画面的文字，原样照用。"""

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


class WholeFilmMusicIn(CamelModel):
    """整片的背景音乐：用哪条音频记录、从它第几毫秒起用，以及整片时间上的音量曲线。"""

    audio_job_id: uuid.UUID
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


class WholeFilmBrandIn(CamelModel):
    """整片的片头或片尾：用哪条品牌模板。"""

    template_id: uuid.UUID


class WholeFilmIn(CamelModel):
    """一条整片的受理输入：一份时间线。可选的片头在最前、片尾在最后，中间各段按顺序首尾相接；整片
    总长是三者之和，片头片尾的时长受理时按模板定。

    字幕与音乐的时间都从第一段开头算（不含片头），只覆盖各段，已由调用方算好，服务端照做。归属参数
    与别的提交端点一样，只是对话必填：整片是一段对话的。``userName`` 只用来替人办事，不进
    ``request``。"""

    segments: Annotated[
        list[WholeFilmSegmentIn], Field(min_length=1, max_length=MAX_COMPOSE_SEGMENTS)
    ]
    subtitles: Annotated[list[WholeFilmSubtitle], Field(max_length=MAX_WHOLE_FILM_SUBTITLES)]
    music: WholeFilmMusicIn | None = None
    font_id: uuid.UUID | None = None
    intro: WholeFilmBrandIn | None = None
    outro: WholeFilmBrandIn | None = None
    user_name: UserName | None = None

    conversation_id: uuid.UUID
    task_id: uuid.UUID | None = None
    metadata: Metadata | None = None

    @model_validator(mode="after")
    def _fits_the_segments(self) -> WholeFilmIn:
        total = self.segments_ms
        previous_end = 0
        for position, subtitle in enumerate(self.subtitles, start=1):
            if subtitle.start_ms < previous_end:
                raise ValueError(f"第 {position} 句字幕与上一句重叠，或没有按时间先后排")
            if subtitle.end_ms > total:
                raise ValueError(
                    f"第 {position} 句字幕结束在 {format_seconds(subtitle.end_ms / 1000)} 秒，"
                    f"超出了整片的 {format_seconds(total / 1000)} 秒"
                )
            previous_end = subtitle.end_ms
        if self.music is not None and self.music.gain[-1].at_ms > total:
            raise ValueError(
                f"音量曲线的最后一个点在 {format_seconds(self.music.gain[-1].at_ms / 1000)} 秒，"
                f"超出了整片的 {format_seconds(total / 1000)} 秒"
            )
        return self

    @property
    def segments_ms(self) -> int:
        return segments_ms(self.segments)


class WholeFilmSegment(WholeFilmSegmentIn):
    url: DownloadUrl


class WholeFilmMusic(WholeFilmMusicIn):
    url: DownloadUrl


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
    style: Literal["normal", "italic", "oblique"]


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

    @property
    def segments_ms(self) -> int:
        return segments_ms(self.segments)

    @property
    def duration_ms(self) -> int:
        brands = sum(brand.duration_ms for brand in (self.intro, self.outro) if brand is not None)
        return self.segments_ms + brands


__all__ = [
    "FILM_LOUDNESS_LUFS",
    "FILM_PEAK_DBFS",
    "MAX_MUSIC_GAIN_POINTS",
    "MAX_WHOLE_FILM_MS",
    "MAX_WHOLE_FILM_SUBTITLES",
    "MAX_WHOLE_FILM_SUBTITLE_CHARS",
    "MUSIC_FADE_OUT_MS",
    "SEGMENT_FADE_MS",
    "SPEECH_LOUDNESS_LUFS",
    "MusicGainPoint",
    "WholeFilmBrand",
    "WholeFilmBrandIn",
    "WholeFilmFont",
    "WholeFilmIn",
    "WholeFilmMusic",
    "WholeFilmMusicIn",
    "WholeFilmRender",
    "WholeFilmRequest",
    "WholeFilmSegment",
    "WholeFilmSegmentIn",
    "WholeFilmSubtitle",
    "segments_ms",
]
