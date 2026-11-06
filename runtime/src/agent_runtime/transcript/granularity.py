from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Final, Literal

from agent_runtime.transcript.ops import EmittableOperation

TranscriptGrade = Literal["off", "turn", "block", "delta"]

GRADE_RANK: Final[Mapping[TranscriptGrade, int]] = {
    "off": 0,
    "turn": 1,
    "block": 2,
    "delta": 3,
}


def grade_for(spec: Mapping[str, TranscriptGrade], agent_id: str) -> TranscriptGrade:
    return spec.get(agent_id) or spec.get("*") or "off"


def admits(grade: TranscriptGrade, operation: EmittableOperation) -> bool:
    if operation.op == "append":
        return GRADE_RANK[grade] >= GRADE_RANK["delta"]
    if operation.op in ("step.upsert", "frame.upsert"):
        return GRADE_RANK[grade] >= GRADE_RANK["block"]
    return True


def filter_ops_for_grade(
    grade: TranscriptGrade, ops: Sequence[EmittableOperation]
) -> tuple[EmittableOperation, ...]:
    if GRADE_RANK[grade] == 0:
        return ()
    return tuple(operation for operation in ops if admits(grade, operation))


def needs_reset_on_transition(previous: TranscriptGrade, current: TranscriptGrade) -> bool:
    return GRADE_RANK[current] > GRADE_RANK[previous]


__all__ = [
    "GRADE_RANK",
    "TranscriptGrade",
    "admits",
    "filter_ops_for_grade",
    "grade_for",
    "needs_reset_on_transition",
]
