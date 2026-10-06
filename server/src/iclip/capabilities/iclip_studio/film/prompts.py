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

_BODY_SENTENCE: Final = re.compile(r"[^。；！？.!?]*" + re.escape(BODY_PHRASE) + r"\.?\s*")
_SENTENCE_END: Final = "。！？.!?…」）)"
_ELEMENT_NOUN: Final = {"人物": "人物", "产品": "产品", "场景": "地方"}


@dataclass(frozen=True, slots=True)
class PicturePrompt:
    """一张图的提示词和按编号排好的参考图。"""

    text: str
    image_urls: tuple[str, ...]


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
    images, marks, notes = _references(film, node, "图", assume_generated)
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
    return PicturePrompt("\n\n".join(part for part in paragraphs if part), tuple(images))


def render_storyboard(film: Film, node: Node, *, assume_generated: bool = False) -> ShotGroup:
    """全局设定加逐镜时间线；镜头时间照文件里写的，不换算。"""

    project = film.project
    images, marks, notes = _references(film, node, "@Image", assume_generated)
    settings = [_block(film, node, STORYBOARD_BLOCK)]
    for cast, mark in zip(project.kids(node, "Cast"), marks, strict=True):
        element = project.nodes[_required(cast, "element")]
        lead = f"{mark}，" if mark else ""
        settings.append(
            f"{element.attrs['type']} {element.attrs['id']}：{lead}{_for_video(element.text)}"
        )
    settings += notes
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
        view = film.image_url(shot.reference("view"), assume_generated=assume_generated)
        if view is not None:
            if view not in images:
                images.append(view)
            text = f"@Image{images.index(view) + 1} 的机位。{text}"
        timeline.append(ShotCut((float(shot.attrs["start"]), float(shot.attrs["end"])), text))
    settings += [f"声音 {role}：{voices[role].text}" for role in speakers if role in voices]
    return ShotGroup(
        global_settings="\n".join(part for part in settings if part),
        timeline=tuple(timeline),
        image_urls=tuple(images),
        seconds=math.ceil(float(shots[-1].attrs["end"])),
    )


def _references(
    film: Film, node: Node, mark: str, assume_generated: bool
) -> tuple[list[str], list[str | None], list[str]]:
    """按写的先后给有图的 Cast 和 Reference 编号。

    返回 (图的地址, 每个 Cast 的记号或 None, 每张有图的 Reference 的说明行)。"""

    project = film.project
    images: list[str] = []
    cast_marks: list[str | None] = []
    notes: list[str] = []
    for child in node.children:
        if project.is_a(child, "Cast"):
            url = film.image_url(child.reference("image"), assume_generated=assume_generated)
            if url is not None:
                images.append(url)
            cast_marks.append(f"{mark}{len(images)}" if url is not None else None)
        elif project.is_a(child, "Reference"):
            url = film.image_url(child.reference("image"), assume_generated=assume_generated)
            if url is not None:
                images.append(url)
                notes.append(f"{mark}{len(images)}：{child.text}")
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


def _for_video(description: str) -> str:
    return _BODY_SENTENCE.sub("", description).strip()


def _required(node: Node, name: str) -> str:
    reference = node.reference(name)
    assert reference is not None, f"{node.tag} 的 {name} 在读文件时已经查过"
    return reference


__all__ = [
    "BODY_PHRASE",
    "LINE_REFERENCE",
    "PICTURE_BLOCKS",
    "STORYBOARD_BLOCK",
    "PicturePrompt",
    "ShotCut",
    "ShotGroup",
    "render_picture",
    "render_storyboard",
]
