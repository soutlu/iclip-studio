from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Final, Protocol

from iclip_video.shot_rules import image_indexes_of, timeline_fault

OUTPUT_CONSTRAINT: Final = "不要生成字幕，不要生成背景音乐。"

SHOTS_HEADING: Final = "镜头："

_TIME_PLACES: Final = 3

_SHOT_LINE: Final = re.compile(r"^(\d+(?:\.\d+)?)–(\d+(?:\.\d+)?)秒 (.*)$")

_SHOT_MARKER: Final = re.compile(r"^\[(\d+(?:\.\d+)?)[–-](\d+(?:\.\d+)?)秒｜镜头\d+\](?: (.*))?$")

_Cut = tuple[float, float, list[str]]


class ShotCutLike(Protocol):
    @property
    def timestamps(self) -> Sequence[float]: ...

    @property
    def prompt(self) -> str: ...


class ShotLike(Protocol):
    @property
    def global_settings(self) -> str: ...

    @property
    def timeline(self) -> Sequence[ShotCutLike]: ...


@dataclass(frozen=True, slots=True)
class ShotCut:
    timestamps: tuple[float, float]
    prompt: str
    image_indexes: tuple[int, ...]


@dataclass(frozen=True, slots=True)
class ShotScript:
    global_settings: str
    timeline: tuple[ShotCut, ...]


def format_seconds(value: float) -> str:
    return f"{round(value, _TIME_PLACES):.{_TIME_PLACES}f}".rstrip("0").rstrip(".")


def format_shot_prompt(shot: ShotLike) -> str:
    lines = [
        f"{format_seconds(item.timestamps[0])}–{format_seconds(item.timestamps[1])}秒 {item.prompt}"
        for item in shot.timeline
    ]
    return (
        f"{shot.global_settings}\n\n{SHOTS_HEADING}\n" + "\n".join(lines) + f"\n{OUTPUT_CONSTRAINT}"
    )


def parse_shot_prompt(text: str) -> ShotScript | None:
    lines = text.split("\n")
    split = _split_headed(lines) if SHOTS_HEADING in lines else _split_marked(lines)
    if split is None:
        return None
    preamble, cuts = split
    if not cuts:
        return None

    previous_end = 0.0
    for position, (start, end, _) in enumerate(cuts, start=1):
        if timeline_fault(position, start, end, previous_end) is not None:
            return None
        previous_end = end

    global_settings = "\n".join(preamble)
    if global_settings.endswith("\n"):
        global_settings = global_settings[:-1]
    timeline = tuple(
        ShotCut(
            timestamps=(start, end),
            prompt="\n".join(body),
            image_indexes=tuple(image_indexes_of("\n".join(body))),
        )
        for start, end, body in cuts
    )
    return ShotScript(global_settings=global_settings, timeline=timeline)


def _split_headed(lines: list[str]) -> tuple[list[str], list[_Cut]] | None:
    heading = lines.index(SHOTS_HEADING)
    body_lines = lines[heading + 1 :]
    if body_lines and body_lines[-1] == OUTPUT_CONSTRAINT:
        body_lines = body_lines[:-1]
    cuts: list[_Cut] = []
    for line in body_lines:
        shot = _SHOT_LINE.match(line)
        if shot is not None:
            cuts.append((float(shot.group(1)), float(shot.group(2)), [shot.group(3)]))
        elif cuts:
            cuts[-1][2].append(line)
        else:
            return None
    return lines[:heading], cuts


def _split_marked(lines: list[str]) -> tuple[list[str], list[_Cut]]:
    preamble: list[str] = []
    cuts: list[_Cut] = []
    for line in lines:
        marker = _SHOT_MARKER.match(line)
        if marker is not None:
            body = marker.group(3)
            cuts.append(
                (float(marker.group(1)), float(marker.group(2)), [] if body is None else [body])
            )
        elif line.strip() == OUTPUT_CONSTRAINT:
            continue
        elif cuts:
            cuts[-1][2].append(line)
        else:
            preamble.append(line)
    return preamble, cuts


__all__ = [
    "OUTPUT_CONSTRAINT",
    "SHOTS_HEADING",
    "ShotCut",
    "ShotCutLike",
    "ShotLike",
    "ShotScript",
    "format_seconds",
    "format_shot_prompt",
    "parse_shot_prompt",
]
