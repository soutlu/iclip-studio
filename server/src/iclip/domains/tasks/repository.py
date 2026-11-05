from __future__ import annotations

import uuid
from collections.abc import Sequence
from datetime import datetime
from typing import Protocol

from iclip.domains.tasks.models import Task, TaskCursor, TaskStatus
from iclip.domains.tasks.schemas import TaskInputs


class TaskRepository(Protocol):
    async def create_if_absent(self, task: Task) -> tuple[Task, bool]: ...

    async def get(self, task_id: uuid.UUID) -> Task: ...

    async def list_recent(
        self,
        *,
        status: TaskStatus | None = None,
        assignee_user_id: uuid.UUID | None = None,
        ids: Sequence[uuid.UUID] | None = None,
        limit: int,
        after: TaskCursor | None = None,
    ) -> tuple[Task, ...]: ...

    async def count(
        self,
        *,
        status: TaskStatus | None = None,
        assignee_user_id: uuid.UUID | None = None,
        ids: Sequence[uuid.UUID] | None = None,
    ) -> int: ...

    async def save(
        self,
        task_id: uuid.UUID,
        *,
        expect: TaskStatus,
        title: str,
        priority: int,
        deadline: datetime | None,
        inputs: TaskInputs,
    ) -> Task | None: ...

    async def publish(self, task_id: uuid.UUID) -> Task | None: ...

    async def confirm(self, task_id: uuid.UUID, *, user_id: uuid.UUID) -> Task | None: ...

    async def set_status(
        self, task_id: uuid.UUID, *, expect: TaskStatus, status: TaskStatus
    ) -> Task | None: ...

    async def delete(self, task_id: uuid.UUID, *, expect: TaskStatus) -> bool: ...


__all__ = ["TaskRepository"]
