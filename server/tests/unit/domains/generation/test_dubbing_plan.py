from __future__ import annotations

import pytest

from iclip.domains.generation.dubbing import (
    MAX_REFERENCE_MS,
    MAX_SPEED,
    ReferenceWindow,
    fit_line,
    line_slots,
    reference_window,
)
from iclip.domains.generation.schemas import DubbedLine, DubbingLine


def lines(*spans: tuple[int, int]) -> list[DubbingLine]:
    return [DubbingLine(start_ms=start, end_ms=end, text="hello") for start, end in spans]


def test_the_reference_is_the_ten_seconds_with_the_most_speech_trimmed_to_the_speech() -> None:
    spoken = lines((0, 1_000), (20_000, 24_000), (25_000, 29_000), (40_000, 41_000))

    window = reference_window(spoken, 60_000)

    assert window == ReferenceWindow(start_ms=20_000, end_ms=29_000, speech_ms=8_000)


def test_a_long_stretch_of_speech_is_cut_to_ten_seconds() -> None:
    spoken = lines((2_000, 30_000))

    window = reference_window(spoken, 40_000)

    assert window.end_ms - window.start_ms == MAX_REFERENCE_MS
    assert window.speech_ms == MAX_REFERENCE_MS
    assert window.start_ms >= 2_000 and window.end_ms <= 30_000


def test_equally_covered_stretches_take_the_earliest() -> None:
    spoken = lines((1_000, 4_000), (30_000, 33_000))

    assert reference_window(spoken, 40_000) == ReferenceWindow(
        start_ms=1_000, end_ms=4_000, speech_ms=3_000
    )


def test_a_video_shorter_than_ten_seconds_is_searched_whole() -> None:
    spoken = lines((500, 1_500), (2_000, 3_200))

    assert reference_window(spoken, 4_000) == ReferenceWindow(
        start_ms=500, end_ms=3_200, speech_ms=2_200
    )


def test_each_line_may_run_up_to_the_next_line_and_the_last_to_the_end() -> None:
    assert line_slots(lines((500, 1_000), (2_000, 2_500), (4_000, 4_800)), 6_000) == (
        1_500,
        2_000,
        2_000,
    )


@pytest.mark.parametrize(
    ("clip_ms", "slot_ms", "expected"),
    [
        (900, 1_000, DubbedLine(index=3, speed=1.0, trimmed=False)),
        (1_000, 1_000, DubbedLine(index=3, speed=1.0, trimmed=False)),
        (1_200, 1_000, DubbedLine(index=3, speed=1.2, trimmed=False)),
        (1_001, 1_000, DubbedLine(index=3, speed=1.001, trimmed=False)),
        (1_250, 1_000, DubbedLine(index=3, speed=MAX_SPEED, trimmed=False)),
        (1_251, 1_000, DubbedLine(index=3, speed=MAX_SPEED, trimmed=True)),
        (3_000, 1_000, DubbedLine(index=3, speed=MAX_SPEED, trimmed=True)),
    ],
    ids=["放得下", "刚好放下", "要加速", "差一点也加速", "加到上限刚好", "上限也放不下", "差很多"],
)
def test_a_line_is_sped_up_by_the_least_that_fits_and_trimmed_past_the_cap(
    clip_ms: int, slot_ms: int, expected: DubbedLine
) -> None:
    assert fit_line(3, clip_ms, slot_ms) == expected
