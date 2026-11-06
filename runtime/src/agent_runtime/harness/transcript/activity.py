from __future__ import annotations

from dataclasses import dataclass

from agent_runtime.harness.job_status import JobStatus
from agent_runtime.transcript.wire import LastTurnReason, PendingInteraction


@dataclass(frozen=True, slots=True)
class ActivityState:
    busy: bool

    pending_interaction: PendingInteraction = "none"

    last_turn_reason: LastTurnReason | None = None


IDLE = ActivityState(busy=False)


def activity_of(status: JobStatus | None) -> ActivityState:
    match status:
        case "running" | "steered":
            return ActivityState(busy=True)
        case "awaiting":
            return ActivityState(busy=True, pending_interaction="approval")
        case "completed" | "failed" | "aborted":
            return ActivityState(busy=False, last_turn_reason=status)
        case _:
            return IDLE


__all__ = [
    "IDLE",
    "ActivityState",
    "activity_of",
]
