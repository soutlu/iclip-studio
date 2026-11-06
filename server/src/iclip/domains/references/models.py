from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Final, Literal

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
    id: uuid.UUID
    video_url: str
    owner_user_id: uuid.UUID
    owner_user_name: str | None
    tag_ids: tuple[uuid.UUID, ...]
    tag_status: str | None
    tag_error: str | None
    breakdown_status: BreakdownStatus
    error_code: BreakdownErrorCode | None
    document: str | None
    version: int
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None


@dataclass(frozen=True, slots=True)
class Claim:
    id: uuid.UUID
    video_url: str
    owner_user_id: uuid.UUID
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
class ReferenceCursor:
    at: datetime
    reference_id: uuid.UUID


__all__ = [
    "BREAKDOWN_TIMEOUT_SECONDS",
    "ERROR_MODEL_CALL_FAILED",
    "ERROR_MODEL_FAILED",
    "ERROR_MODEL_UNAVAILABLE",
    "ERROR_TIMEOUT",
    "ERROR_VIDEO_UNREADABLE",
    "STATUS_COMPLETED",
    "STATUS_FAILED",
    "STATUS_PENDING",
    "STATUS_RUNNING",
    "TEST_VIDEO_COMPLETED",
    "TEST_VIDEO_FAILED",
    "TEST_VIDEO_RUNNING",
    "BreakdownErrorCode",
    "BreakdownFailed",
    "BreakdownStatus",
    "Claim",
    "Outcome",
    "ReferenceCursor",
    "ReferenceVideo",
    "Scope",
    "TestVideoJob",
    "TestVideoStatus",
]
