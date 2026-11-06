from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Literal, Protocol

BreakdownFailureReason = Literal[
    "video_unreadable", "model_call_failed", "model_failed", "model_unavailable", "timeout"
]


@dataclass(frozen=True, slots=True)
class FailedBreakdown:
    reason: BreakdownFailureReason


class ReferenceBreakdowns(Protocol):
    async def ensure(self, user_id: uuid.UUID, video_url: str) -> str | FailedBreakdown: ...


__all__ = [
    "BreakdownFailureReason",
    "FailedBreakdown",
    "ReferenceBreakdowns",
]
