"""试生成的提示词：只用一份拆解的文字拼一段文生视频的正文，看拆解有没有漏掉什么。

拆解的格式由拆解提示词规定（``capabilities/iclip_studio/breakdown/prompt.py``）：``# 出场元素`` 下一张
表，``# 时间线`` 下 ``### 镜 NN · 起-止`` 逐镜六块。这里只取出场元素的辨识特征与每镜的镜头语言、画面、
音效；BGM、包装、关键帧、段落标题与整片分析都不进提示词。"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Final

from iclip.common.errors import ValidationFailed
from iclip.common.shot_prompt import ShotCut, ShotScript, format_shot_prompt

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
    """拼好的正文，与按最后一镜的结束向上取整的秒数。"""

    __test__ = False  # 名字以 Test 开头，测试模块导入它时别让 pytest 当成测试类去收

    text: str
    seconds: int


@dataclass(frozen=True, slots=True)
class _Shot:
    start: float
    end: float
    blocks: dict[str, list[str]]


def build_test_prompt(document: str) -> TestPrompt:
    """出场元素每行一句当全局设定，按出片的拼法（``format_shot_prompt``）拼成正文。

    每镜正文写 ``镜头语言。画面``，音效不是「无」时再接 `` 音效：…``；一块写了几行的，去掉
    ``- `` 前缀用「；」连起来。没有出场元素、没有镜头，或某一镜缺镜头语言或画面，抛
    ``ValidationFailed``。"""

    sections = _sections(document)
    elements = _element_lines(sections.get(_ELEMENTS, []))
    shots = _shots(sections.get(_TIMELINE, []))
    if not elements or not shots:
        raise ValidationFailed(_INCOMPLETE)
    script = ShotScript(
        global_settings="\n".join(elements),
        # 文生视频没有参考图，正文里也就没有 @ImageN。
        timeline=tuple(
            ShotCut(timestamps=(shot.start, shot.end), prompt=_shot_body(shot), image_indexes=())
            for shot in shots
        ),
    )
    return TestPrompt(text=format_shot_prompt(script), seconds=math.ceil(shots[-1].end))


def _sections(document: str) -> dict[str, list[str]]:
    """按一级标题切开；同名的一级标题只认第一个。"""

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
    """表里每一行写成 ``类型 名字：辨识特征``；表头、分隔行和不够四格的行跳过。"""

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
        # 辨识特征里万一写了竖线，中间几格拼回去；最后一格是首次出现，丢掉。
        kind, name, features = cells[0], cells[1], "|".join(cells[2:-1])
        found.append(f"{kind} {name}：{features}")
    return found


def _shots(lines: list[str]) -> list[_Shot]:
    """时间线里的各镜，按出现的先后；每块收下标签那一行冒号后的字和后面接着的几行。"""

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
