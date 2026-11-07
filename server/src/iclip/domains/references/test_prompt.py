from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Final

from cue.errors import ValidationFailed
from iclip_video.shot_prompt import ShotCut, ShotScript, format_shot_prompt

_ELEMENTS: Final = "出场元素"
_TIMELINE: Final = "时间线"
_LENS: Final = "镜头语言"
_PICTURE: Final = "画面"
_SOUND: Final = "音效"
_NONE: Final = "无"

_SECTION: Final = re.compile(r"^#\s+(.+?)\s*$")
_HEADING: Final = re.compile(r"^#{1,6}\s")
_SHOT: Final = re.compile(r"^###\s*镜\s*\d+\s*·\s*(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*$")
_BLOCK: Final = re.compile(r"^\*\*(.+?)\*\*\s*[：:]\s*(.*)$")
_SEPARATOR_CELL: Final = re.compile(r"^:?-+:?$")
_HEADER: Final = ("类型", "名字", "辨识特征", "首次出现")

_INCOMPLETE: Final = "拆解格式不完整，无法试生成"


@dataclass(frozen=True, slots=True)
class TestPrompt:
    __test__ = False

    text: str
    seconds: int


@dataclass(frozen=True, slots=True)
class _Shot:
    start: float
    end: float
    blocks: dict[str, list[str]]


def build_test_prompt(document: str) -> TestPrompt:
    sections = _sections(document)
    elements = _element_lines(sections.get(_ELEMENTS, []))
    shots = _shots(sections.get(_TIMELINE, []))
    if not elements or not shots:
        raise ValidationFailed(_INCOMPLETE)
    script = ShotScript(
        global_settings="\n".join(elements),
        timeline=tuple(
            ShotCut(timestamps=(shot.start, shot.end), prompt=_shot_body(shot), image_indexes=())
            for shot in shots
        ),
    )
    return TestPrompt(text=format_shot_prompt(script), seconds=math.ceil(shots[-1].end))


def _sections(document: str) -> dict[str, list[str]]:
    sections: dict[str, list[str]] = {}
    current: list[str] | None = None
    for line in document.splitlines():
        heading = _SECTION.match(line)
        if heading is not None:
            name = heading.group(1)
            current = None if name in sections else sections.setdefault(name, [])
            continue
        if current is not None:
            current.append(line)
    return sections


def _element_lines(lines: list[str]) -> list[str]:
    found: list[str] = []
    for line in lines:
        stripped = line.strip()
        if not stripped.startswith("|"):
            continue
        cells = [cell.strip() for cell in stripped.strip("|").split("|")]
        if len(cells) < len(_HEADER) or tuple(cells) == _HEADER:
            continue
        if all(_SEPARATOR_CELL.match(cell) for cell in cells):
            continue
        kind, name, features = cells[0], cells[1], "|".join(cells[2:-1])
        found.append(f"{kind} {name}：{features}")
    return found


def _shots(lines: list[str]) -> list[_Shot]:
    shots: list[_Shot] = []
    block: list[str] | None = None
    for line in lines:
        stripped = line.strip()
        shot = _SHOT.match(stripped)
        if shot is not None:
            shots.append(_Shot(start=float(shot.group(1)), end=float(shot.group(2)), blocks={}))
            block = None
            continue
        if _HEADING.match(stripped):
            block = None
            continue
        if not shots:
            continue
        labelled = _BLOCK.match(stripped)
        if labelled is not None:
            block = shots[-1].blocks.setdefault(labelled.group(1).strip(), [])
            stripped = labelled.group(2).strip()
        if block is None or not stripped:
            continue
        block.append(stripped.removeprefix("- ").strip())
    return shots


def _shot_body(shot: _Shot) -> str:
    lens = "；".join(shot.blocks.get(_LENS, []))
    picture = "；".join(shot.blocks.get(_PICTURE, []))
    if not lens or not picture:
        raise ValidationFailed(_INCOMPLETE)
    body = f"{lens.rstrip('。')}。{picture}"
    sound = "；".join(shot.blocks.get(_SOUND, []))
    if sound and sound != _NONE:
        body += f" 音效：{sound}"
    return body


__all__ = ["TestPrompt", "build_test_prompt"]
