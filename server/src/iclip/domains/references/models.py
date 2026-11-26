from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Final, Literal, get_args

from iclip.common.final_cut import TargetLocale

ReferenceKind = Literal["video", "audio"]

KIND_VIDEO: Final = "video"
KIND_AUDIO: Final = "audio"

AudioKind = Literal["voice", "bgm", "sfx"]
"""参考音频的子类：音色（配音照它的声音念）、配乐、音效。"""

AUDIO_VOICE: Final = "voice"
AUDIO_BGM: Final = "bgm"
AUDIO_SFX: Final = "sfx"

AUDIO_KINDS: Final[tuple[AudioKind, ...]] = get_args(AudioKind)

# 音色的时长：下限与配音从原声里截参考时要求的说话时长相同，上限是语音合成模型收的参考上限。
MIN_VOICE_MS: Final = 3_000
MAX_VOICE_MS: Final = 30_000

VoiceGender = Literal["male", "female", "neutral"]
VoiceAge = Literal["young", "middle", "senior"]
VoiceScenario = Literal[
    "commercials",
    "social",
    "documentaries",
    "explainers",
    "tutorials",
    "trailers",
    "characters",
    "wellness",
]
BgmMood = Literal["warm", "relaxed", "uplifting", "epic", "suspense"]
BgmGenre = Literal["acoustic", "piano", "electronic", "orchestral"]
SfxCategory = Literal["transition", "ui", "impact", "ambience", "foley"]

MAX_SCENARIOS: Final = 2
MIN_BPM: Final = 20
MAX_BPM: Final = 300

Tempo = Literal["slow", "medium", "fast"]
"""按 ``bpm`` 分的速度档：``slow`` 低于 ``SLOW_BELOW_BPM``，``fast`` 高于 ``FAST_ABOVE_BPM``，
其余是 ``medium``。"""

TEMPO_SLOW: Final = "slow"
TEMPO_MEDIUM: Final = "medium"
TEMPO_FAST: Final = "fast"
SLOW_BELOW_BPM: Final = 90
FAST_ABOVE_BPM: Final = 120

# 列表行与试听条画的波形有多少根柱子。
PEAK_BUCKETS: Final = 120

BreakdownStatus = Literal["pending", "running", "completed", "failed"]

STATUS_PENDING: Final = "pending"
STATUS_RUNNING: Final = "running"
STATUS_COMPLETED: Final = "completed"
STATUS_FAILED: Final = "failed"

BreakdownErrorCode = Literal[
    "video_unreadable", "model_call_failed", "model_failed", "model_unavailable", "timeout"
]

ERROR_VIDEO_UNREADABLE: Final = "video_unreadable"
ERROR_MODEL_CALL_FAILED: Final = "model_call_failed"
ERROR_MODEL_FAILED: Final = "model_failed"
ERROR_MODEL_UNAVAILABLE: Final = "model_unavailable"
ERROR_TIMEOUT: Final = "timeout"

BREAKDOWN_TIMEOUT_SECONDS: Final = 20 * 60


class BreakdownFailed(Exception):
    def __init__(self, message: str, *, code: BreakdownErrorCode) -> None:
        super().__init__(message)
        self.code: BreakdownErrorCode = code


@dataclass(frozen=True, slots=True)
class ReferenceVideo:
    """一条参考视频：主表的身份与归属，加视频子表的拆解与最新一次试生成（``test_job_id``）。"""

    id: uuid.UUID
    video_url: str
    owner_user_id: uuid.UUID
    owner_user_name: str | None
    upload_id: uuid.UUID | None
    source_job_id: uuid.UUID | None
    tag_ids: tuple[uuid.UUID, ...]
    tag_status: str | None
    tag_error: str | None
    breakdown_status: BreakdownStatus
    error_code: BreakdownErrorCode | None
    document: str | None
    version: int
    test_job_id: uuid.UUID | None
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None


@dataclass(frozen=True, slots=True)
class AudioTraits:
    """参考音频的选填属性，各属其类：性别、年龄段、使用场景只有音色有，情绪、曲风、``bpm`` 只有
    配乐有，音效类别只有音效有。"""

    gender: VoiceGender | None = None
    age: VoiceAge | None = None
    scenarios: tuple[VoiceScenario, ...] = ()
    mood: BgmMood | None = None
    genre: BgmGenre | None = None
    bpm: int | None = None
    sfx_category: SfxCategory | None = None


@dataclass(frozen=True, slots=True)
class MeasuredAudio:
    """入库时按地址量出来的：时长（毫秒），与 ``PEAK_BUCKETS`` 个归一到 0～1 的波形峰值。"""

    duration_ms: int
    peaks: tuple[float, ...]


@dataclass(frozen=True, slots=True)
class ReferenceAudio:
    """一条参考音频：主表的身份、归属与时长，加音频子表的子类、语种、台词（只有音色有台词）、属性
    与波形峰值（这批属性之前入库的没有峰值）。"""

    id: uuid.UUID
    url: str
    title: str
    description: str | None
    duration_ms: int
    owner_user_id: uuid.UUID
    owner_user_name: str | None
    upload_id: uuid.UUID | None
    source_job_id: uuid.UUID | None
    audio_kind: AudioKind
    locale: TargetLocale | None
    transcript: str | None
    traits: AudioTraits
    peaks: tuple[float, ...] | None
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None


@dataclass(frozen=True, slots=True)
class NewReferenceAudio:
    url: str
    title: str
    description: str | None
    duration_ms: int
    owner_user_id: uuid.UUID
    api_key_id: uuid.UUID | None
    upload_id: uuid.UUID | None
    source_job_id: uuid.UUID | None
    audio_kind: AudioKind
    locale: TargetLocale | None
    transcript: str | None
    traits: AudioTraits
    peaks: tuple[float, ...]


@dataclass(frozen=True, slots=True)
class AudioText:
    """参考音频上能改的几项。"""

    title: str
    description: str | None
    locale: TargetLocale | None
    transcript: str | None
    traits: AudioTraits


@dataclass(frozen=True, slots=True)
class Claim:
    """认领下来要拆的一条；``requested_by`` 是排上这次拆解的人，拆解按他的配置组调模型，为空即默认组。"""

    id: uuid.UUID
    video_url: str
    owner_user_id: uuid.UUID
    requested_by: uuid.UUID | None
    started_at: datetime


@dataclass(frozen=True, slots=True)
class Outcome:
    document: str | None
    error_code: BreakdownErrorCode | None = None


TestVideoStatus = Literal["running", "completed", "failed"]

TEST_VIDEO_RUNNING: Final = "running"
TEST_VIDEO_COMPLETED: Final = "completed"
TEST_VIDEO_FAILED: Final = "failed"


@dataclass(frozen=True, slots=True)
class TestVideoJob:
    job_id: uuid.UUID
    status: TestVideoStatus
    url: str | None
    error_message: str | None
    prompt: str | None
    created_at: datetime


@dataclass(frozen=True, slots=True)
class Scope:
    tag_groups: tuple[tuple[uuid.UUID, ...], ...] = ()
    user_name: str | None = None
    q: str | None = None
    since: datetime | None = None
    until: datetime | None = None


@dataclass(frozen=True, slots=True)
class AudioScope:
    """参考音频列表的筛选：每个元组里命中任一即算，空元组不筛；``locales`` 里的 ``None`` 是没设语种。"""

    audio_kind: AudioKind | None = None
    locales: tuple[TargetLocale | None, ...] = ()
    genders: tuple[VoiceGender, ...] = ()
    ages: tuple[VoiceAge, ...] = ()
    scenarios: tuple[VoiceScenario, ...] = ()
    moods: tuple[BgmMood, ...] = ()
    genres: tuple[BgmGenre, ...] = ()
    tempos: tuple[Tempo, ...] = ()
    sfx_categories: tuple[SfxCategory, ...] = ()
    user_name: str | None = None
    q: str | None = None
    since: datetime | None = None
    until: datetime | None = None


@dataclass(frozen=True, slots=True)
class ReferenceCursor:
    at: datetime
    reference_id: uuid.UUID


__all__ = [
    "AUDIO_BGM",
    "AUDIO_KINDS",
    "AUDIO_SFX",
    "AUDIO_VOICE",
    "BREAKDOWN_TIMEOUT_SECONDS",
    "ERROR_MODEL_CALL_FAILED",
    "ERROR_MODEL_FAILED",
    "ERROR_MODEL_UNAVAILABLE",
    "ERROR_TIMEOUT",
    "ERROR_VIDEO_UNREADABLE",
    "FAST_ABOVE_BPM",
    "KIND_AUDIO",
    "KIND_VIDEO",
    "MAX_BPM",
    "MAX_SCENARIOS",
    "MAX_VOICE_MS",
    "MIN_BPM",
    "MIN_VOICE_MS",
    "PEAK_BUCKETS",
    "SLOW_BELOW_BPM",
    "STATUS_COMPLETED",
    "STATUS_FAILED",
    "STATUS_PENDING",
    "STATUS_RUNNING",
    "TEMPO_FAST",
    "TEMPO_MEDIUM",
    "TEMPO_SLOW",
    "TEST_VIDEO_COMPLETED",
    "TEST_VIDEO_FAILED",
    "TEST_VIDEO_RUNNING",
    "AudioKind",
    "AudioScope",
    "AudioText",
    "AudioTraits",
    "BgmGenre",
    "BgmMood",
    "BreakdownErrorCode",
    "BreakdownFailed",
    "BreakdownStatus",
    "Claim",
    "MeasuredAudio",
    "NewReferenceAudio",
    "Outcome",
    "ReferenceAudio",
    "ReferenceCursor",
    "ReferenceKind",
    "ReferenceVideo",
    "Scope",
    "SfxCategory",
    "Tempo",
    "TestVideoJob",
    "TestVideoStatus",
    "VoiceAge",
    "VoiceGender",
    "VoiceScenario",
]
