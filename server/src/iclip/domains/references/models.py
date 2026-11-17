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
class ReferenceAudio:
    """一条参考音频：主表的身份、归属与时长，加音频子表的子类、语种与台词（只有音色有台词）。"""

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


@dataclass(frozen=True, slots=True)
class AudioText:
    """参考音频上能改的几项。"""

    title: str
    description: str | None
    locale: TargetLocale | None
    transcript: str | None


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
    audio_kind: AudioKind | None = None
    locale: TargetLocale | None = None
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
    "KIND_AUDIO",
    "KIND_VIDEO",
    "MAX_VOICE_MS",
    "MIN_VOICE_MS",
    "STATUS_COMPLETED",
    "STATUS_FAILED",
    "STATUS_PENDING",
    "STATUS_RUNNING",
    "TEST_VIDEO_COMPLETED",
    "TEST_VIDEO_FAILED",
    "TEST_VIDEO_RUNNING",
    "AudioKind",
    "AudioScope",
    "AudioText",
    "BreakdownErrorCode",
    "BreakdownFailed",
    "BreakdownStatus",
    "Claim",
    "NewReferenceAudio",
    "Outcome",
    "ReferenceAudio",
    "ReferenceCursor",
    "ReferenceKind",
    "ReferenceVideo",
    "Scope",
    "TestVideoJob",
    "TestVideoStatus",
]
