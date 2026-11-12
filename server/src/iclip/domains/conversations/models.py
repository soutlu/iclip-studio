from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

TitleKind = Literal["default", "generated", "custom"]


@dataclass(frozen=True, slots=True)
class Conversation:
    id: uuid.UUID
    owner_user_id: uuid.UUID
    agent_id: str
    title: str
    title_kind: TitleKind
    last_run_id: str | None
    task_id: uuid.UUID | None
    collection_id: uuid.UUID | None
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None = None
    completed_at: datetime | None = None
    forked_from: uuid.UUID | None = None
    fork_turn: int | None = None
    same_as: uuid.UUID | None = None


@dataclass(frozen=True, slots=True)
class AgentPreview:
    id: uuid.UUID
    owner_user_id: uuid.UUID
    agent_id: str
    version_id: uuid.UUID | None
    created_at: datetime


PREVIEW_TITLE = "测试预览"


@dataclass(frozen=True, slots=True)
class PreviewHeader:
    agent_id: str
    owner_user_id: uuid.UUID
    title: str = PREVIEW_TITLE
    deleted_at: datetime | None = None
    forked_from: uuid.UUID | None = None
    fork_turn: int | None = None


@dataclass(frozen=True, slots=True)
class ConversationActivity:
    busy: bool = False
    pending_interaction: Literal["none", "approval", "question"] = "none"
    last_turn_reason: Literal["completed", "failed", "aborted"] | None = None


IDLE_ACTIVITY = ConversationActivity()

VideoPhase = Literal["queued", "running"]


@dataclass(frozen=True, slots=True)
class WholeFilmDraft:
    conversation_id: uuid.UUID
    html: str
    revision: int
    updated_by: uuid.UUID
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class WholeFilmSource:
    """成片文件里用到的一条素材：它出自哪条生成记录、文件里写的地址。"""

    job_id: uuid.UUID
    url: str


@dataclass(frozen=True, slots=True)
class CheckedWholeFilm:
    """查过的成片文件：``html`` 是按写法重写后的那一份。"""

    html: str
    duration_ms: int
    sources: tuple[WholeFilmSource, ...]


WholeFilmExportStatus = Literal["queued", "rendering", "uploading", "done", "failed", "cancelled"]


@dataclass(frozen=True, slots=True)
class WholeFilmExportError:
    code: str
    message: str


@dataclass(frozen=True, slots=True)
class WholeFilmExport:
    id: uuid.UUID
    status: WholeFilmExportStatus
    progress: float | None
    queue_position: int | None
    error: WholeFilmExportError | None
    download_url: str | None


__all__ = [
    "IDLE_ACTIVITY",
    "PREVIEW_TITLE",
    "AgentPreview",
    "CheckedWholeFilm",
    "Conversation",
    "ConversationActivity",
    "PreviewHeader",
    "TitleKind",
    "VideoPhase",
    "WholeFilmDraft",
    "WholeFilmExport",
    "WholeFilmExportError",
    "WholeFilmExportStatus",
    "WholeFilmSource",
]
