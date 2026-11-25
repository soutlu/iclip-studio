from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Final, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)
from pydantic.alias_generators import to_camel

from iclip.common.final_cut import TargetLocale
from iclip.domains.references.models import (
    AUDIO_BGM,
    AUDIO_SFX,
    AUDIO_VOICE,
    MAX_BPM,
    MAX_SCENARIOS,
    MIN_BPM,
    PEAK_BUCKETS,
    AudioKind,
    AudioTraits,
    BgmGenre,
    BgmMood,
    BreakdownErrorCode,
    BreakdownStatus,
    SfxCategory,
    TestVideoStatus,
    VoiceAge,
    VoiceGender,
    VoiceScenario,
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
Scenarios = Annotated[
    list[VoiceScenario],
    Field(max_length=MAX_SCENARIOS, description=f"使用场景，至多 {MAX_SCENARIOS} 个、不重复"),
]
Bpm = Annotated[int, Field(ge=MIN_BPM, le=MAX_BPM, description=f"每分钟拍数，{MIN_BPM}～{MAX_BPM}")]

_ONE_SOURCE: Final = "uploadId 与 sourceJobId 要给且只给一个"
_VOICE_ONLY_TRANSCRIPT: Final = "只有音色（voice）能填台词 transcript"

_KIND_NAMES: Final[dict[AudioKind, str]] = {
    AUDIO_VOICE: "音色",
    AUDIO_BGM: "配乐",
    AUDIO_SFX: "音效",
}

# 每个属性归哪个子类、叫什么；键是 AudioTraits 的字段名。
_TRAIT_OWNERS: Final[dict[str, tuple[AudioKind, str]]] = {
    "gender": (AUDIO_VOICE, "性别"),
    "age": (AUDIO_VOICE, "年龄段"),
    "scenarios": (AUDIO_VOICE, "使用场景"),
    "mood": (AUDIO_BGM, "情绪"),
    "genre": (AUDIO_BGM, "曲风"),
    "bpm": (AUDIO_BGM, "速度"),
    "sfx_category": (AUDIO_SFX, "音效类别"),
}


def trait_kind_error(audio_kind: AudioKind, traits: AudioTraits) -> str | None:
    """``traits`` 里填了不属于 ``audio_kind`` 的属性时答一句说明，都属于时为 None。"""

    for name, (owner, label) in _TRAIT_OWNERS.items():
        if owner != audio_kind and getattr(traits, name) not in (None, ()):
            return f"只有{_KIND_NAMES[owner]}（{owner}）能填{label} {to_camel(name)}"
    return None


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


class _AudioTraitsIn(CamelModel):
    """参考音频的选填属性：性别、年龄段、使用场景只有音色能填，情绪、曲风、``bpm`` 只有配乐能填，
    音效类别只有音效能填。"""

    gender: VoiceGender | None = None
    age: VoiceAge | None = None
    scenarios: Scenarios | None = None
    mood: BgmMood | None = None
    genre: BgmGenre | None = None
    bpm: Bpm | None = None
    sfx_category: SfxCategory | None = None

    @field_validator("scenarios")
    @classmethod
    def _distinct_scenarios(cls, value: list[VoiceScenario] | None) -> list[VoiceScenario] | None:
        if value is not None and len(set(value)) != len(value):
            raise ValueError("使用场景 scenarios 不能重复")
        return value

    def traits_over(self, base: AudioTraits) -> AudioTraits:
        """``base`` 上换掉这次给了的属性；给 ``null``（``scenarios`` 也可给 ``[]``）是清空。"""

        given = self.model_fields_set
        return AudioTraits(
            gender=self.gender if "gender" in given else base.gender,
            age=self.age if "age" in given else base.age,
            scenarios=tuple(self.scenarios or ()) if "scenarios" in given else base.scenarios,
            mood=self.mood if "mood" in given else base.mood,
            genre=self.genre if "genre" in given else base.genre,
            bpm=self.bpm if "bpm" in given else base.bpm,
            sfx_category=self.sfx_category if "sfx_category" in given else base.sfx_category,
        )


class ReferenceAudioCreateIn(_OneSource, _AudioTraitsIn):
    """把一段音频放进参考音频库：调用者本人的一条音频上传（``uploadId``），或调用者看得到的一条已完成
    的背景音乐（``sourceJobId``）。台词只有音色能填，属性各属其类。"""

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

    @model_validator(mode="after")
    def _traits_of_kind(self) -> ReferenceAudioCreateIn:
        error = trait_kind_error(self.audio_kind, self.traits_over(AudioTraits()))
        if error is not None:
            raise ValueError(error)
        return self


class ReferenceAudioUpdateIn(_AudioTraitsIn):
    """改一条参考音频：给了的字段才改，``description`` / ``locale`` / ``transcript`` 与各项属性给
    ``null`` 是清空（``scenarios`` 也可给 ``[]``）；标题不能清空。台词只有音色能填，属性各属其类。"""

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
    gender: VoiceGender | None
    age: VoiceAge | None
    scenarios: list[VoiceScenario]
    mood: BgmMood | None
    genre: BgmGenre | None
    bpm: int | None
    sfx_category: SfxCategory | None
    peaks: list[float] | None = Field(
        description=f"波形峰值：{PEAK_BUCKETS} 个，归一到 0～1（全程静音时全是 0）；"
        "入库时没量过波形的旧条目为 null，重新上传才有"
    )
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
    "trait_kind_error",
]
