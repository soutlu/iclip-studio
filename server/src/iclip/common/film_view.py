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
    """生图描述里一张参考图所在的位置，即文件里写 ``@ImageN`` 的地方。"""

    node: str
    label: str
    url: str | None
    """现在的地址；还没有选用时为 None。"""

    number: int
    """这张参考图在这张图自己的参考图列表里的位置，即 ``@ImageN`` 的 N，从 1 起。"""


FilmPromptRun = FilmPromptText | FilmPromptImage


@dataclass(frozen=True, slots=True)
class FilmFrame:
    """镜头组里的一张图：先是这组视频的参考图列表，按列表先后；再是这组镜头里还没进列表的机位图
    （没选用的），按镜头先后，它们没有编号，照样能生成、能选用。"""

    node: str
    """图片节点；换图时原样传回。"""

    label: str
    """给人看的名字：机位图叫「镜头 N」（别组的叫「第 M 组镜头 N」），其余的叫图片节点的名字。"""

    kind: FrameKind
    url: str | None
    """现在用的图；还没有图时为 None。"""

    number: int | None
    """在这组参考图列表里的位置，即 @ImageN 的 N，从 1 起；列表里没有图的也有，没进列表的机位图为
    None。"""

    prompt: tuple[FilmPromptRun, ...] | None
    """按描述生成这张图时发给模型的描述，按 ``@ImageN`` 拆成文字段和图片段，没有图的参考图也拆出来。
    用户给的图为 None。"""

    aspect_ratio: str | None
    """这张图的画幅：生成图照文件里写的；用户给的图文件里不写，为 None。"""

    missing: tuple[str, ...]
    """这张图的参考图列表里现在没有图的那几张的称呼（叫法同 ``label``），按列表先后；不为空时这张图
    不能生成。用户给的图为空。"""


@dataclass(frozen=True, slots=True)
class FilmSetting:
    """全局设定里的一段：拍法、一个出场元素的描述或一个声音。"""

    kind: SettingKind
    target: str | None
    """改这段字时传回；这段在文件里没法单独改时为 None。"""

    label: str | None
    """段首的称呼：模板里这个槽的段名去掉冒号，如「拍摄与剪辑」「人物」「声音」；同一个槽的几段
    同一个称呼。声音的说话人写在正文开头。"""

    text: str
    images: tuple[str, ...]
    """恒为空：这组的图都在 ``FilmGroup.frames`` 里。"""


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
    prompt: str
    """这组发给视频模型的正文，与出片时发的逐字相同；缺图时照样拼出，只是不能出片。"""


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
    images: tuple[str, ...] = ()
    """这段字里新插入的图的地址。这组视频的参考图列表现在有 M 张时，字里的 ``@Image1``…``@ImageM``
    指列表里现有的图，``@Image(M+1)``…``@Image(M+k)`` 依次指这里的第 1…k 张。"""


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
