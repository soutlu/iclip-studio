from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from iclip.domains.identity.public import ActAs
from iclip.domains.tasks.api import create_tasks_router
from iclip.domains.tasks.repository import TaskRepository
from iclip.domains.tasks.service import TaskService


@dataclass(frozen=True)
class TasksModule:
    routers: tuple[Any, ...]

    service: TaskService


def build_tasks_module(repo: TaskRepository, *, act_as: ActAs) -> TasksModule:
    service = TaskService(repo)
    return TasksModule(routers=(create_tasks_router(service, act_as=act_as),), service=service)


__all__ = ["TasksModule", "build_tasks_module"]
