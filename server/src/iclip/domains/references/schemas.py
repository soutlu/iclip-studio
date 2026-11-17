from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Final, Literal

from pydantic import BaseModel, ConfigDict, StringConstraints, model_validator
from pydantic.alias_generators import to_camel

from iclip.common.final_cut import TargetLocale
from iclip.domains.references.models import (
    AUDIO_VOICE,
    AudioKind,
    BreakdownErrorCode,
    BreakdownStatus,
    TestVideoStatus,
)
from iclip.domains.tagging.public import TagErrorCode, TagStatus

MAX_USER_NAME_CHARS: Final = 200
MAX_TITLE_CHARS: Final = 200
MAX_DESCRIPTION_CHARS: Final = 2000
MAX_TRANSCRIPT_CHARS: Final = 2000

UserName = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_USER_NAME_CHARS)
]
Title = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_TITLE_CHARS)
]
Description = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_DESCRIPTION_CHARS)
]
Transcript = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_TRANSCRIPT_CHARS)
]

_ONE_SOURCE: Final = "uploadId 与 sourceJobId 要给且只给一个"
_VOICE_ONLY_TRANSCRIPT: Final = "只有音色（voice）能填台词 transcript"


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True
    )


class _OneSource(CamelModel):
    upload_id: uuid.UUID | None = None
    source_job_id: uuid.UUID | None = None

    @model_validator(mode="after")
    def _exactly_one_source(self) -> _OneSource:
        if (self.upload_id is None) == (self.source_job_id is None):
            raise ValueError(_ONE_SOURCE)
        return self


class ReferenceVideoCreateIn(_OneSource):
    """把一条视频放进资料库：调用者本人的一条视频上传（``uploadId``），或调用者看得到的一条已完成的
    素材片（``sourceJobId``）。"""


class ReferenceVideoUpdateIn(CamelModel):
    """改拆解正文。"""

    version: int
    document: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class ReferenceTagsIn(CamelModel):
    """整份替换这条参考视频在所有维度上的标签。"""

    tag_ids: list[uuid.UUID]


class ReferenceVideoItemOut(CamelModel):
    """列表里的一条参考视频；不带拆解正文，正文在详情里。"""

    id: uuid.UUID
    video_url: str
    user_name: str | None
    tag_ids: list[uuid.UUID]
    tag_status: TagStatus | None
    tag_error: TagErrorCode | None
    breakdown_status: BreakdownStatus
    error_code: BreakdownErrorCode | None
    version: int
    can_edit: bool
    created_at: datetime
    updated_at: datetime


class TestVideoIn(CamelModel):
    """试生成的请求：画幅与归属标签由调用方定，其余参数服务端定。"""

    aspect_ratio: Literal["9:16", "16:9", "1:1", "3:4", "4:3"]
    user_name: UserName | None = None


class TestVideoOut(CamelModel):
    """这条参考视频最新的一次试生成，不论谁发起；所有读者看到的是同一条。"""

    job_id: uuid.UUID
    status: TestVideoStatus
    url: str | None
    error_message: str | None
    stale: bool
    created_at: datetime


class ReferenceVideoOut(ReferenceVideoItemOut):
    """一条参考视频，连同当前拆解与最新的一次试生成。"""

    document: str | None
    test_video: TestVideoOut | None


class ReferenceVideosOut(CamelModel):
    items: list[ReferenceVideoItemOut]
    next_cursor: str | None
    total: int | None
    can_upload: bool


class OwnerCountOut(CamelModel):
    user_name: str
    count: int


class ReferenceVideoFiltersOut(CamelModel):
    owners: list[OwnerCountOut]


class ReferenceAudioCreateIn(_OneSource):
    """把一段音频放进参考音频库：调用者本人的一条音频上传（``uploadId``），或调用者看得到的一条已完成
    的背景音乐（``sourceJobId``）。台词只有音色能填。"""

    title: Title
    audio_kind: AudioKind
    description: Description | None = None
    locale: TargetLocale | None = None
    transcript: Transcript | None = None
    user_name: UserName | None = None

    @model_validator(mode="after")
    def _transcript_only_for_voice(self) -> ReferenceAudioCreateIn:
        if self.transcript is not None and self.audio_kind != AUDIO_VOICE:
            raise ValueError(_VOICE_ONLY_TRANSCRIPT)
        return self


class ReferenceAudioUpdateIn(CamelModel):
    """改一条参考音频：给了的字段才改，``description`` / ``locale`` / ``transcript`` 给 ``null`` 是
    清空；标题不能清空。台词只有音色能填。"""

    title: Title | None = None
    description: Description | None = None
    locale: TargetLocale | None = None
    transcript: Transcript | None = None

    @model_validator(mode="after")
    def _title_not_cleared(self) -> ReferenceAudioUpdateIn:
        if "title" in self.model_fields_set and self.title is None:
            raise ValueError("标题不能清空")
        return self


class ReferenceAudioOut(CamelModel):
    """一条参考音频。"""

    id: uuid.UUID
    url: str
    title: str
    description: str | None
    duration_ms: int
    audio_kind: AudioKind
    locale: TargetLocale | None
    transcript: str | None
    user_name: str | None
    upload_id: uuid.UUID | None
    source_job_id: uuid.UUID | None
    can_edit: bool
    created_at: datetime
    updated_at: datetime


class ReferenceAudiosOut(CamelModel):
    items: list[ReferenceAudioOut]
    next_cursor: str | None
    total: int | None
    can_upload: bool


class AudioKindCountOut(CamelModel):
    audio_kind: AudioKind
    count: int


class ReferenceAudioFiltersOut(CamelModel):
    audio_kinds: list[AudioKindCountOut]
    owners: list[OwnerCountOut]


__all__ = [
    "MAX_DESCRIPTION_CHARS",
    "MAX_TITLE_CHARS",
    "MAX_TRANSCRIPT_CHARS",
    "MAX_USER_NAME_CHARS",
    "AudioKindCountOut",
    "OwnerCountOut",
    "ReferenceAudioCreateIn",
    "ReferenceAudioFiltersOut",
    "ReferenceAudioOut",
    "ReferenceAudioUpdateIn",
    "ReferenceAudiosOut",
    "ReferenceTagsIn",
    "ReferenceVideoCreateIn",
    "ReferenceVideoFiltersOut",
    "ReferenceVideoItemOut",
    "ReferenceVideoOut",
    "ReferenceVideoUpdateIn",
    "ReferenceVideosOut",
    "TestVideoIn",
    "TestVideoOut",
]
