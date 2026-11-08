from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal

OverviewBucket = Literal["hour", "day", "week"]

ExecutionSort = Literal["start", "retries", "cycle", "tokens"]

SortOrder = Literal["asc", "desc"]

ExecutionAnomalyKind = Literal["retry", "stuck", "spend", "task_stuck"]


@dataclass(frozen=True, slots=True)
class Scope:
    since: datetime
    until: datetime | None = None
    user_name: str | None = None


__all__ = [
    "ExecutionAnomalyKind",
    "ExecutionSort",
    "OverviewBucket",
    "Scope",
    "SortOrder",
]
