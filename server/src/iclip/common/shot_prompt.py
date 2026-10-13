"""镜头组与视频提示词之间的拼装规则及其逆。

调用方交的是结构化的镜头组（与分镜文件 video_shot.json 同形：全局设定 + 逐镜起止秒与正文），
发给视频模型的却是一段正文。这段正文长什么样只在这里定：前端「复制完整提示词」照同一规则
显示，生成记录里存的也是这里拼出来的。改了这里就等于改了发给模型的东西。

现行写法是全局设定、空一行、``镜头：``、每镜一行 ``起–止秒 正文``、末尾约束（ADR-0002）。
反拆给读历史记录用：结构化字段上线前（2026-09-09）出的片只存了拼好的正文，其中还有两种旧写法，
每镜以 ``[起–止秒｜镜头N]`` 开头，作品库仍要读得出来。"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Final, Protocol

from iclip.common.shot_rules import image_indexes_of, timeline_fault

OUTPUT_CONSTRAINT: Final = "不要生成字幕，不要生成背景音乐。"
"""每段正文的最后一行。"""

SHOTS_HEADING: Final = "镜头："
"""全局设定之后、逐镜各行之前独占的一行。"""

_TIME_PLACES: Final = 3
"""起止秒数保留到毫秒，整秒不带小数点：JSON 里的 4.0 与浏览器里的 4 才会拼出同一行。"""

_SHOT_LINE: Final = re.compile(r"^(\d+(?:\.\d+)?)–(\d+(?:\.\d+)?)秒 (.*)$")
"""现行写法里一镜的开头 ``起–止秒 正文``，只在 ``镜头：`` 之后认。"""

_SHOT_MARKER: Final = re.compile(r"^\[(\d+(?:\.\d+)?)[–-](\d+(?:\.\d+)?)秒｜镜头\d+\](?: (.*))?$")
"""旧写法里一镜的开头 ``[起–止秒｜镜头N] 正文``。标记后没有空格与正文的，是 2026-09-08 之前
「标记独占一行、正文另起一行」的更早写法。"""

_Cut = tuple[float, float, list[str]]
"""拆的过程中的一镜：起、止、正文各行。"""


class ShotCutLike(Protocol):
    @property
    def timestamps(self) -> tuple[float, float]: ...

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
    """从正文拆回来的镜头组，与出片请求里的 ``shot`` 同形。"""

    global_settings: str
    timeline: tuple[ShotCut, ...]


def format_seconds(value: float) -> str:
    """整秒不带小数点，其余去掉末尾的零：3.5、4、8.25。"""

    return f"{round(value, _TIME_PLACES):.{_TIME_PLACES}f}".rstrip("0").rstrip(".")


def format_shot_prompt(shot: ShotLike) -> str:
    """拼成发给模型的正文：全局设定、空一行、``镜头：``、每镜一行 ``起–止秒 正文``、末尾约束。

    起止照给的，不重算；全局设定与各镜正文里的空白和换行原样保留。"""

    lines = [
        f"{format_seconds(item.timestamps[0])}–{format_seconds(item.timestamps[1])}秒 {item.prompt}"
        for item in shot.timeline
    ]
    return (
        f"{shot.global_settings}\n\n{SHOTS_HEADING}\n" + "\n".join(lines) + f"\n{OUTPUT_CONSTRAINT}"
    )


def parse_shot_prompt(text: str) -> ShotScript | None:
    """``format_shot_prompt`` 的逆：把正文拆回镜头组。

    有独占一行的 ``镜头：`` 就按现行写法拆：第一个 ``镜头：`` 之前是全局设定，之后每行以
    ``起–止秒 `` 开头的是一镜，其余行接在上一镜的正文后面，只有最后一行是约束时才去掉它。
    对这里拼出来的正文拆回去再拼一字不差，除非某镜正文里有一行本身就以 ``起–止秒 `` 开头。

    没有 ``镜头：`` 就按旧写法找 ``[起–止秒｜镜头N]`` 标记；旧写法（含标记独占一行、约束行夹在
    全局设定里的更早写法）拆得开，但不保证拼回原样。

    拆不出镜头、``镜头：`` 后第一行不是一镜，或拆出的时间线接不上（结束不晚于开始、第一镜
    不从 0 起、镜头交叠），都不算镜头组，返回 None，调用方按纯文本处理。
    """

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

    # 拼装时全局设定后面跟一个空行：其中一个换行成了行尾，另一个留成了空行，拆回来要去掉。
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
    """现行写法：``镜头：`` 之前是全局设定，之后逐镜；``镜头：`` 后第一行不是一镜就返回 None。"""

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
    """旧写法：第一个标记之前是全局设定，任何位置的约束行都丢掉。"""

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
