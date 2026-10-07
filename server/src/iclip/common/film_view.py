"""制作页看到的工程：AI 导演的工程文件按视频请求分组排好，给人看、改字、换图。

工程文件的读法与规则在 ``capabilities/iclip_studio/film``，对话域只认这里的形状：组合根读文件、
检查后填好它们，对话域管权限并原样交给接口。``target`` 与 ``node`` 是同一版文件里的定位，前端
原样传回，不解析。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

FrameKind = Literal["generated", "photo"]
"""``generated`` 按描述生成，能重新生成；``photo`` 是用户给的图，只能换。"""

SettingKind = Literal["shooting", "element", "voice"]


@dataclass(frozen=True, slots=True)
class FilmPromptText:
    """生图描述里的一段文字。"""

    text: str


@dataclass(frozen=True, slots=True)
class FilmPromptImage:
    """生图描述里一张参考图所在的位置。"""

    node: str
    label: str
    url: str


FilmPromptRun = FilmPromptText | FilmPromptImage


@dataclass(frozen=True, slots=True)
class FilmFrame:
    """一组视频请求用到的一张图。"""

    node: str
    """图片节点；换图时原样传回。"""

    label: str
    """给人看的名字：出场元素的图叫元素的名字，机位图叫「镜头 N」。"""

    kind: FrameKind
    url: str | None
    """现在用的图；还没有图时为 None。"""

    number: int | None
    """发给视频的编号，即 @N：只给有图的，按发送的先后从 1 起。"""

    prompt: tuple[FilmPromptRun, ...] | None
    """按描述生成这张图时发给模型的描述，参考图在它出现的位置；用户给的图为 None。还没有图的
    参考图不在这里出现，只用文字写。"""


@dataclass(frozen=True, slots=True)
class FilmSetting:
    """全局设定里的一段：拍法、一个出场元素的描述或一个声音。"""

    kind: SettingKind
    target: str | None
    """改这段字时传回；这段在文件里没法单独改时为 None。"""

    label: str | None
    """段首的称呼，如「人物 短发女生」「声音 旁白」；拍法没有。"""

    text: str
    image: str | None
    """出场元素挂的图片节点；没挂图为 None。"""


@dataclass(frozen=True, slots=True)
class FilmLine:
    """镜头里的一句台词：说话人不变，只改字。"""

    target: str
    """改这个镜头时用它对上是哪一句。"""

    role: str
    """说话人。"""

    text: str


@dataclass(frozen=True, slots=True)
class FilmShot:
    target: str | None
    """改这个镜头的字和台词时传回；没法在页面上改时为 None。"""

    start: float
    end: float
    parts: tuple[str, ...]
    """台词前后的文字，比 ``lines`` 多一段；第 i 句台词夹在第 i 段与第 i+1 段之间。"""

    lines: tuple[FilmLine, ...]
    view: str | None
    """这个镜头的机位图的图片节点；没写机位图为 None。"""


@dataclass(frozen=True, slots=True)
class FilmGroup:
    """一次视频请求：一个镜头组。"""

    index: int
    """从 1 起，与文件里视频节点的先后相同。"""

    video: str
    """视频节点；出片时原样传回。"""

    model: str
    seconds: int
    aspect_ratio: str
    frames: tuple[FilmFrame, ...]
    settings: tuple[FilmSetting, ...]
    shots: tuple[FilmShot, ...]


@dataclass(frozen=True, slots=True)
class FilmView:
    film_version: int
    run_version: int | None
    """运行文件的版本；还没有运行文件时为 None。"""

    problems: int
    """两个文件一起检查出的问题数；不为 0 时 ``groups`` 为空，等 AI 导演改好。"""

    groups: tuple[FilmGroup, ...]


@dataclass(frozen=True, slots=True)
class FilmImagePrompt:
    """按描述再生成时，在编辑器里改过的描述与参考图；只用这一次，不写回文件。"""

    text: str
    reference_image_urls: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class FilmLineEdit:
    """改好的一句台词的字。"""

    target: str
    text: str


@dataclass(frozen=True, slots=True)
class FilmTextEdit:
    """改一段字。镜头给 ``parts`` 与 ``lines``：这一镜的每句台词按原来的先后列全，``parts`` 比它
    多一段；其余给 ``text``。"""

    target: str
    text: str | None = None
    parts: tuple[str, ...] | None = None
    lines: tuple[FilmLineEdit, ...] | None = None


__all__ = [
    "FilmFrame",
    "FilmGroup",
    "FilmImagePrompt",
    "FilmLine",
    "FilmLineEdit",
    "FilmPromptImage",
    "FilmPromptRun",
    "FilmPromptText",
    "FilmSetting",
    "FilmShot",
    "FilmTextEdit",
    "FilmView",
    "FrameKind",
    "SettingKind",
]
