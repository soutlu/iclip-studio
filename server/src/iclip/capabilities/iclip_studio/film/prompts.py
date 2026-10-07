"""把 ``Picture`` 和 ``Storyboard`` 拼成提示词。

规则只在这里定，标签上没有模板属性。图的编号不写在文件里：按写的先后，只给现在有图的编号，
所以用户生成了哪些图，文件都不用改。这里不加任何固定的话。"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Final

from iclip.capabilities.iclip_studio.film.film import Film
from iclip.capabilities.iclip_studio.film.markup import Node

BODY_PHRASE: Final = "very broad shoulders and excellent head-to-shoulder proportions"
"""人物身材那句英文固定的后半句。这一句只给生图用，拼视频的全局设定时整句去掉。"""

PICTURE_BLOCKS: Final = ("拍摄", "取景", "环境")
"""``Picture`` 里由作者写的块；主体从 Cast 的出场元素取。"""

STORYBOARD_BLOCK: Final = "拍摄与剪辑"

LINE_REFERENCE: Final = re.compile(r"\{([^{}]*)\}")
"""镜头正文里的 ``{台词名}``。"""

_MARK: Final = re.compile("\x00(\\d+)\x00")
"""拼生图描述时参考图编号的占位：文件正文里不会有 NUL 字符。"""

_BODY_SENTENCE: Final = re.compile(r"[^。；！？.!?]*" + re.escape(BODY_PHRASE) + r"\.?\s*")
_SENTENCE_END: Final = "。！？.!?…」）)"
_ELEMENT_NOUN: Final = {"人物": "人物", "产品": "产品", "场景": "地方"}


@dataclass(frozen=True, slots=True)
class PictureImage:
    """生图描述里引用的一张参考图。"""

    image: str
    """图片节点的名字。"""

    url: str
    number: int
    """在参考图里排第几，从 1 起；描述里写成「图N」。"""


@dataclass(frozen=True, slots=True)
class PicturePrompt:
    """一张图的提示词和按编号排好的参考图。

    ``runs`` 是同一段提示词按参考图拆开：文字原样，参考图在「图N」的位置；``text`` 由它拼成。"""

    runs: tuple[str | PictureImage, ...]
    image_urls: tuple[str, ...]

    @property
    def text(self) -> str:
        return "".join(run if isinstance(run, str) else f"图{run.number}" for run in self.runs)


@dataclass(frozen=True, slots=True)
class ImageUse:
    """``Storyboard`` 里写了图的一处。"""

    holder: Node
    """写这张图的 ``Cast``、``Reference`` 或 ``Shot``。"""

    image: str
    """图片节点的名字。"""

    url: str | None
    number: int | None
    """在发给视频的参考图里排第几，从 1 起；还没有图为 None。"""


@dataclass(frozen=True, slots=True)
class ShotCut:
    timestamps: tuple[float, float]
    prompt: str


@dataclass(frozen=True, slots=True)
class ShotGroup:
    """一次视频请求：与分镜文件里的一个镜头组同形，另带参考图和时长。"""

    global_settings: str
    timeline: tuple[ShotCut, ...]
    image_urls: tuple[str, ...]
    seconds: int


def render_picture(film: Film, node: Node, *, assume_generated: bool = False) -> PicturePrompt:
    """拍摄、主体、取景、环境四段话，段与段之间空一行，最后是每张 Reference 的用途。"""

    project = film.project
    images, marks, notes = _references(film, node, assume_generated)
    subject: list[str] = []
    setting: list[str] = []
    for cast, mark in zip(project.kids(node, "Cast"), marks, strict=True):
        element = project.nodes[_required(cast, "element")]
        kind = element.attrs["type"]
        lead = f"{mark} 的{_ELEMENT_NOUN[kind]}，" if mark else ""
        (setting if kind == "场景" else subject).append(_sentences(lead + element.text))
    extra = _block(film, node, "环境")
    if extra:
        setting.append(extra)
    paragraphs = [
        _block(film, node, "拍摄"),
        "".join(subject),
        _block(film, node, "取景"),
        "".join(setting),
        "\n".join(notes),
    ]
    joined = "\n\n".join(part for part in paragraphs if part)
    runs: list[str | PictureImage] = []
    for index, piece in enumerate(_MARK.split(joined)):
        if index % 2:
            number = int(piece)
            name, url = images[number - 1]
            runs.append(PictureImage(name, url, number))
        elif piece:
            runs.append(piece)
    return PicturePrompt(tuple(runs), tuple(url for _, url in images))


def render_storyboard(film: Film, node: Node, *, assume_generated: bool = False) -> ShotGroup:
    """全局设定加逐镜时间线；镜头时间照文件里写的，不换算。"""

    project = film.project
    uses, images = storyboard_images(film, node, assume_generated=assume_generated)
    numbers = {use.holder: use.number for use in uses if use.number is not None}
    settings = [_block(film, node, STORYBOARD_BLOCK)]
    for cast in project.kids(node, "Cast"):
        element = project.nodes[_required(cast, "element")]
        lead = f"@Image{numbers[cast]}，" if cast in numbers else ""
        settings.append(
            f"{element.attrs['type']} {element.attrs['id']}：{lead}{for_video(element.text)}"
        )
    settings += [
        f"@Image{numbers[reference]}：{reference.text}"
        for reference in project.kids(node, "Reference")
        if reference in numbers
    ]
    voices = {voice.attrs["role"]: voice for voice in project.find("Voice")}
    speakers: list[str] = []

    def say(match: re.Match[str]) -> str:
        line = project.nodes.get(match.group(1))
        if line is None or not project.is_a(line, "Line"):
            return match.group(0)
        role = line.attrs["role"]
        if role not in speakers:
            speakers.append(role)
        return "{" + line.text + "}"

    shots = project.kids(node, "Shot")
    timeline: list[ShotCut] = []
    for shot in shots:
        text = LINE_REFERENCE.sub(say, shot.text)
        if shot in numbers:
            text = f"@Image{numbers[shot]} 的机位。{text}"
        timeline.append(ShotCut((float(shot.attrs["start"]), float(shot.attrs["end"])), text))
    settings += [f"声音 {role}：{voices[role].text}" for role in speakers if role in voices]
    return ShotGroup(
        global_settings="\n".join(part for part in settings if part),
        timeline=tuple(timeline),
        image_urls=tuple(images),
        seconds=math.ceil(float(shots[-1].attrs["end"])),
    )


def storyboard_images(
    film: Film, node: Node, *, assume_generated: bool = False
) -> tuple[list[ImageUse], list[str]]:
    """``Storyboard`` 用到的图，按发给视频的先后：先是 Cast 与 Reference，按写的先后；再是各镜头
    的机位图，与前面同一张的共用编号。只给有图的编号。

    返回 (每一处写了图的地方, 按编号排好的地址)。"""

    project = film.project
    uses: list[ImageUse] = []
    images: list[str] = []
    for child in node.children:
        if not (project.is_a(child, "Cast") or project.is_a(child, "Reference")):
            continue
        reference = child.reference("image")
        if reference is None:
            continue
        url = film.image_url(reference, assume_generated=assume_generated)
        if url is not None:
            images.append(url)
        number = len(images) if url is not None else None
        uses.append(ImageUse(child, reference.partition(".")[0], url, number))
    for shot in project.kids(node, "Shot"):
        reference = shot.reference("view")
        if reference is None:
            continue
        url = film.image_url(reference, assume_generated=assume_generated)
        if url is not None and url not in images:
            images.append(url)
        number = images.index(url) + 1 if url is not None else None
        uses.append(ImageUse(shot, reference.partition(".")[0], url, number))
    return uses, images


def _references(
    film: Film, node: Node, assume_generated: bool
) -> tuple[list[tuple[str, str]], list[str | None], list[str]]:
    """按写的先后给有图的 Cast 和 Reference 编号。

    返回 (按编号排的 (图片节点名, 地址), 每个 Cast 的记号或 None, 每张有图的 Reference 的说明行)。
    记号是 ``_MARK`` 认得的占位，拼完再换成「图N」或拆成参考图。"""

    project = film.project
    images: list[tuple[str, str]] = []
    cast_marks: list[str | None] = []
    notes: list[str] = []
    for child in node.children:
        is_cast = project.is_a(child, "Cast")
        if not (is_cast or project.is_a(child, "Reference")):
            continue
        reference = child.reference("image")
        url = film.image_url(reference, assume_generated=assume_generated)
        if url is not None:
            assert reference is not None
            images.append((reference.partition(".")[0], url))
        mark = f"\x00{len(images)}\x00" if url is not None else None
        if is_cast:
            cast_marks.append(mark)
        elif mark is not None:
            notes.append(f"{mark}：{child.text}")
    return images, cast_marks, notes


def _block(film: Film, node: Node, name: str) -> str:
    """一个 Block 的文字：``text`` 引用的那段在前，正文接在后面；没写这一块是空串。"""

    project = film.project
    for block in project.kids(node, "Block"):
        if block.attrs["name"] != name:
            continue
        shared = block.reference("text")
        head = project.nodes[shared].text if shared is not None else ""
        if name == STORYBOARD_BLOCK:
            return "\n".join(part for part in (head, block.text) if part)
        return _sentences(head, block.text)
    return ""


def _sentences(*pieces: str) -> str:
    """几段文字接成一段：每段各成一句，句末没有标点的补句号。"""

    out: list[str] = []
    for piece in pieces:
        stripped = piece.strip()
        if stripped:
            out.append(stripped if stripped[-1] in _SENTENCE_END else stripped + "。")
    return "".join(out)


def for_video(description: str) -> str:
    """出场元素的描述去掉只给生图用的那句英文身材句。"""

    return _BODY_SENTENCE.sub("", description).strip()


def body_sentence(description: str) -> re.Match[str] | None:
    """出场元素描述里那句英文身材句；没写为 None。"""

    return _BODY_SENTENCE.search(description)


def _required(node: Node, name: str) -> str:
    reference = node.reference(name)
    assert reference is not None, f"{node.tag} 的 {name} 在读文件时已经查过"
    return reference


__all__ = [
    "BODY_PHRASE",
    "LINE_REFERENCE",
    "PICTURE_BLOCKS",
    "STORYBOARD_BLOCK",
    "ImageUse",
    "PictureImage",
    "PicturePrompt",
    "ShotCut",
    "ShotGroup",
    "body_sentence",
    "for_video",
    "render_picture",
    "render_storyboard",
    "storyboard_images",
]
