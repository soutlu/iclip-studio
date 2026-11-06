from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Final, Literal

SkillStatus = Literal["active", "archived"]

STATUS_ACTIVE: Final = "active"
STATUS_ARCHIVED: Final = "archived"

SKILL_MD: Final = "SKILL.md"

REFERENCES_DIR: Final = "references/"

MAX_NAME_CHARS: Final = 64

MAX_DISPLAY_NAME_CHARS: Final = 100
MAX_DESCRIPTION_CHARS: Final = 1024

MAX_FILE_BYTES: Final = 1024 * 1024

MAX_TOTAL_BYTES: Final = 5 * 1024 * 1024

MAX_FILES: Final = 200

MAX_ARCHIVE_BYTES: Final = 6 * 1024 * 1024


@dataclass(frozen=True, slots=True)
class FileEntry:
    path: str
    size: int
    hash: str


@dataclass(frozen=True, slots=True)
class DraftFileInfo:
    path: str
    size: int
    hash: str
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class DraftFile:
    path: str
    content: str
    size: int
    hash: str
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class Skill:
    id: uuid.UUID
    name: str
    display_name: str
    description: str
    latest_version_id: uuid.UUID | None
    latest_version: int | None
    latest_content_hash: str | None
    status: SkillStatus
    created_by: uuid.UUID
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class SkillSummary:
    skill: Skill
    draft_hash: str


@dataclass(frozen=True, slots=True)
class SkillVersion:
    id: uuid.UUID
    skill_id: uuid.UUID
    version: int
    note: str | None
    manifest: tuple[FileEntry, ...]
    content_hash: str
    created_by: uuid.UUID
    created_at: datetime


__all__ = [
    "MAX_ARCHIVE_BYTES",
    "MAX_DESCRIPTION_CHARS",
    "MAX_DISPLAY_NAME_CHARS",
    "MAX_FILES",
    "MAX_FILE_BYTES",
    "MAX_NAME_CHARS",
    "MAX_TOTAL_BYTES",
    "REFERENCES_DIR",
    "SKILL_MD",
    "STATUS_ACTIVE",
    "STATUS_ARCHIVED",
    "DraftFile",
    "DraftFileInfo",
    "FileEntry",
    "Skill",
    "SkillStatus",
    "SkillSummary",
    "SkillVersion",
]
