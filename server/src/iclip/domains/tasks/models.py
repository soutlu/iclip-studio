from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Final

from iclip.domains.tasks.schemas import TaskInputs, TaskStatus

STATUS_DRAFT: Final = "draft"
STATUS_PUBLISHED: Final = "published"
STATUS_CONFIRMED: Final = "confirmed"
STATUS_WITHDRAWN: Final = "withdrawn"

ACTIVE_STATUSES: Final = frozenset({STATUS_PUBLISHED, STATUS_CONFIRMED})

TASK_STATUSES: Final = (STATUS_DRAFT, STATUS_PUBLISHED, STATUS_CONFIRMED, STATUS_WITHDRAWN)


@dataclass(frozen=True, slots=True)
class Task:
    id: uuid.UUID
    title: str
    status: TaskStatus
    priority: int
    deadline: datetime | None
    creator_user_id: uuid.UUID
    inputs: TaskInputs
    created_at: datetime
    updated_at: datetime
    assignee_user_ids: tuple[uuid.UUID, ...] = field(default_factory=tuple)


@dataclass(frozen=True, slots=True)
class TaskCursor:
    created_at: datetime
    task_id: uuid.UUID


__all__ = [
    "ACTIVE_STATUSES",
    "STATUS_CONFIRMED",
    "STATUS_DRAFT",
    "STATUS_PUBLISHED",
    "STATUS_WITHDRAWN",
    "TASK_STATUSES",
    "Task",
    "TaskCursor",
    "TaskStatus",
]
