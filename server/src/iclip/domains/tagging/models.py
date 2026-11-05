from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Final, Literal

AutoFill = Literal["ai"]

AUTO_FILL_AI: Final = "ai"

EntryKind = Literal["reference", "hit_case"]

KIND_REFERENCE: Final = "reference"
KIND_HIT_CASE: Final = "hit_case"
ENTRY_KINDS: Final[tuple[EntryKind, ...]] = (KIND_REFERENCE, KIND_HIT_CASE)

TagStatus = Literal["pending", "running", "completed", "failed"]

STATUS_PENDING: Final = "pending"
STATUS_RUNNING: Final = "running"
STATUS_COMPLETED: Final = "completed"
STATUS_FAILED: Final = "failed"
BUSY_STATUSES: Final = frozenset({STATUS_PENDING, STATUS_RUNNING})

TagErrorCode = Literal[
    "no_source_text", "model_call_failed", "model_failed", "model_unavailable", "timeout"
]

ERROR_NO_SOURCE_TEXT: Final = "no_source_text"
ERROR_MODEL_CALL_FAILED: Final = "model_call_failed"
ERROR_MODEL_FAILED: Final = "model_failed"
ERROR_MODEL_UNAVAILABLE: Final = "model_unavailable"
ERROR_TIMEOUT: Final = "timeout"

TAGGING_TIMEOUT_SECONDS: Final = 10 * 60

AI_VALUE_LIMIT: Final = 500

MAX_TAG_NAME_CHARS: Final = 50
MAX_TAG_GUIDE_CHARS: Final = 1000


@dataclass(frozen=True, slots=True)
class TagNode:
    id: uuid.UUID
    parent_id: uuid.UUID | None
    name: str
    auto_fill: AutoFill | None
    guide: str | None
    position: int
    children: tuple[TagNode, ...] = ()

    def descendants(self) -> tuple[TagNode, ...]:
        found: list[TagNode] = []
        for child in self.children:
            found.append(child)
            found.extend(child.descendants())
        return tuple(found)


@dataclass(frozen=True, slots=True)
class TagCounts:
    references: int = 0
    hit_cases: int = 0


@dataclass(frozen=True, slots=True)
class EntryKey:
    kind: EntryKind
    subject_id: uuid.UUID


@dataclass(frozen=True, slots=True)
class Claim:
    entry_id: uuid.UUID
    key: EntryKey
    started_at: datetime


class TaggingFailed(Exception):
    def __init__(self, message: str, *, code: TagErrorCode) -> None:
        super().__init__(message)
        self.code: TagErrorCode = code


__all__ = [
    "AI_VALUE_LIMIT",
    "AUTO_FILL_AI",
    "BUSY_STATUSES",
    "ENTRY_KINDS",
    "ERROR_MODEL_CALL_FAILED",
    "ERROR_MODEL_FAILED",
    "ERROR_MODEL_UNAVAILABLE",
    "ERROR_NO_SOURCE_TEXT",
    "ERROR_TIMEOUT",
    "KIND_HIT_CASE",
    "KIND_REFERENCE",
    "MAX_TAG_GUIDE_CHARS",
    "MAX_TAG_NAME_CHARS",
    "STATUS_COMPLETED",
    "STATUS_FAILED",
    "STATUS_PENDING",
    "STATUS_RUNNING",
    "TAGGING_TIMEOUT_SECONDS",
    "AutoFill",
    "Claim",
    "EntryKey",
    "EntryKind",
    "TagCounts",
    "TagErrorCode",
    "TagNode",
    "TagStatus",
    "TaggingFailed",
]
