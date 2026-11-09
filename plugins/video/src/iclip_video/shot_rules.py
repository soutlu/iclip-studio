from __future__ import annotations

import re
from typing import Final, Literal

MAX_REFERENCE_IMAGES: Final = 30

MAX_PROMPT_CHARS: Final = 4000

_IMAGE_REFERENCE: Final = re.compile(r"@Image(\d+)")

TimelineFault = Literal["not_after_start", "first_not_at_zero", "overlaps_previous"]


def image_indexes_of(text: str) -> list[int]:
    return list(dict.fromkeys(int(number) for number in _IMAGE_REFERENCE.findall(text)))


def first_unavailable_image(text: str, available: int) -> int | None:
    return next((number for number in image_indexes_of(text) if not 1 <= number <= available), None)


def timeline_fault(
    position: int, start: float, end: float, previous_end: float
) -> TimelineFault | None:
    if end <= start:
        return "not_after_start"
    if position == 1 and start != 0:
        return "first_not_at_zero"
    if start < previous_end:
        return "overlaps_previous"
    return None


__all__ = [
    "MAX_PROMPT_CHARS",
    "MAX_REFERENCE_IMAGES",
    "TimelineFault",
    "first_unavailable_image",
    "image_indexes_of",
    "timeline_fault",
]
