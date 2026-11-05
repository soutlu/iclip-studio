from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Final, Literal

from iclip.domains.generation.schemas import (
    KIND_VIDEO,
    OPERATION_COMPOSE,
    OPERATION_GENERATE,
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_PENDING,
    STATUS_SUBMITTED,
    STATUS_SUBMITTING,
    GenerationKind,
    GenerationOperation,
    GenerationStatus,
    SnakeModel,
    SubtitleSentence,
)
from iclip.domains.generation.stored_requests import GenerationRequest

TERMINAL_STATUSES: Final = frozenset({STATUS_COMPLETED, STATUS_FAILED})

REFERENCE_TRIAL_KEY: Final = "referenceId"

InFlightPhase = Literal["queued", "running"]

Inheritance = Sequence[tuple[uuid.UUID, datetime]]


class GenerationOutput(SnakeModel):
    url: str | None = None
    watermark_url: str | None = None
    duration_ms: int | None = None
    content_md5: str | None = None
    sentences: tuple[SubtitleSentence, ...] | None = None


@dataclass(frozen=True, slots=True)
class GenerationJob:
    id: uuid.UUID
    owner_user_id: uuid.UUID
    api_key_id: uuid.UUID | None
    kind: GenerationKind
    operation: GenerationOperation
    provider: str | None
    request: GenerationRequest | None
    status: GenerationStatus
    provider_task_id: str | None
    provider_status: str | None
    output: GenerationOutput
    error_code: str | None
    error_message: str | None
    created_at: datetime
    submitted_at: datetime | None
    finished_at: datetime | None
    conversation_id: uuid.UUID | None = None
    metadata: dict[str, Any] | None = None
    task_id: uuid.UUID | None = None
    shot_index: int | None = None
    root_job_id: uuid.UUID | None = None
    source_job_id: uuid.UUID | None = None


def inherited_through(job: GenerationJob, inheritance: Inheritance) -> bool:
    if job.status != STATUS_COMPLETED or job.finished_at is None:
        return False
    return any(
        job.conversation_id == ancestor and job.finished_at <= boundary
        for ancestor, boundary in inheritance
    )


def is_base_master(job: GenerationJob) -> bool:
    return (
        job.kind == KIND_VIDEO
        and job.status == STATUS_COMPLETED
        and job.output.url is not None
        and (
            job.operation == OPERATION_COMPOSE
            or (job.operation == OPERATION_GENERATE and job.source_job_id is None)
        )
    )


def is_finished_edit(job: GenerationJob) -> bool:
    return (
        job.kind == KIND_VIDEO
        and job.operation == OPERATION_GENERATE
        and job.source_job_id is not None
        and job.status == STATUS_COMPLETED
        and job.output.url is not None
    )


__all__ = [
    "REFERENCE_TRIAL_KEY",
    "STATUS_COMPLETED",
    "STATUS_FAILED",
    "STATUS_PENDING",
    "STATUS_SUBMITTED",
    "STATUS_SUBMITTING",
    "TERMINAL_STATUSES",
    "GenerationJob",
    "GenerationKind",
    "GenerationOperation",
    "GenerationOutput",
    "GenerationStatus",
    "InFlightPhase",
    "Inheritance",
    "inherited_through",
    "is_base_master",
    "is_finished_edit",
]
