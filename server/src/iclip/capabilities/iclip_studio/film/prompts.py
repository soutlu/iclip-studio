"""按模板把生成节点的提示词拼出来：``画面-v1`` 拼一张图的描述，``多镜头视频-v1`` 拼一次视频请求。

两份模板各有一套写法，只在这里定。图的编号不写在文件里：每次生成时按生成节点下列的参考图先后，
只给现在有图的编号，视频再接上各镜的机位图；所以用户生成了哪些图，文件都不用改。这里不加任何
固定的话，段名来自模板。"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Final

from iclip.capabilities.iclip_studio.film.document import Document
from iclip.capabilities.iclip_studio.film.film import Film
from iclip.capabilities.iclip_studio.film.kits import (
    PICTURE_SCENE_SLOT,
    VIDEO_ELEMENT_SLOTS,
    VIDEO_KIT,
    VIDEO_SHOOTING_SLOT,
    VIDEO_SHOTS_SLOT,
    VIDEO_VOICE_SLOT,
)
from iclip.capabilities.iclip_studio.film.markup import Node
from iclip.capabilities.shot_document import (
    StoredTimelineItem,
    StoredVideoShotPrompt,
    VideoShotDocumentRow,
)
from iclip.common.shot_rules import image_indexes_of

LINE_REFERENCE: Final = re.compile(r"\{([^{}]*)\}")
"""镜头正文里的 ``{段名}``。"""

_MARK: Final = re.compile("\x00(\\d+)\x00")
"""拼生图描述时参考图编号的占位：文件正文里不会有 NUL 字符。"""

_SENTENCE_END: Final = "。！？.!?…」）)"
_LATIN_END: Final = ".!?)"
"""以这几个英文标点结尾的文字，后面接别的字先空一格。"""


@dataclass(frozen=True, slots=True)
class PictureImage:
    """生图描述里引用的一张参考图。"""

    image: str
    """图片节点的名字。"""

    url: str
    number: int
    """在参考图里排第几，从 1 起；描述里写成 ``@ImageN``。"""


@dataclass(frozen=True, slots=True)
class PicturePrompt:
    """一张图的提示词和按编号排好的参考图。

    ``runs`` 是同一段提示词按参考图拆开：文字原样，参考图在 ``@ImageN`` 的位置；``text`` 由它拼成。"""

    runs: tuple[str | PictureImage, ...]
    image_urls: tuple[str, ...]

    @property
    def text(self) -> str:
        return "".join(run if isinstance(run, str) else f"@Image{run.number}" for run in self.runs)


@dataclass(frozen=True, slots=True)
class ImageUse:
    """视频节点用到的一张图的一处。"""

    holder: Node
    """写这张图的 ``Reference`` 或 ``film:Shot``。"""

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


def slot_values(project: Document, render: Node) -> dict[str, list[Node]]:
    """一个 ``text:Render`` 每个槽里填的节点，按 ``Set``、``Append`` 写的先后；槽按模板的先后，
    没填的槽是空列表。只用在检查过引用的文件上。"""

    kit = project.template(_required(render, "template"))
    filled: dict[str, list[Node]] = {slot.name: [] for slot in kit.slots}
    for child in render.children:
        if project.is_a(child, "Set") or project.is_a(child, "Append"):
            value = project.nodes[_required(child, "text")]
            filled.setdefault(child.attrs["name"], []).append(value)
    return filled


def references(project: Document, node: Node) -> list[Node]:
    """生成节点下列的参考图，按先后。"""

    return project.kids(node, "Reference")


def is_kit(project: Document, node: Node, kit: str) -> bool:
    """``node`` 是不是按模板 ``kit`` 拼的 ``text:Render``。"""

    if not project.is_a(node, "Render"):
        return False
    return project.template(_required(node, "template")).name == kit


def element_names(project: Document) -> set[str]:
    """出场元素：被某个参考图的 ``for`` 指着、或填进某个视频提示词人物、产品、场景槽的文字。"""

    names: set[str] = set()
    for node in project.root.walk():
        if project.is_a(node, "Reference") and (target := node.reference("for")) is not None:
            names.add(target)
        elif is_kit(project, node, VIDEO_KIT):
            filled = slot_values(project, node)
            for slot in VIDEO_ELEMENT_SLOTS:
                names.update(value.attrs["id"] for value in filled[slot])
    return names


def video_shots(project: Document, video: Node) -> Node:
    """视频节点提示词「镜头」槽里的 ``film:Shots``。"""

    prompt = project.nodes[_required(video, "prompt")]
    return slot_values(project, prompt)[VIDEO_SHOTS_SLOT][0]


def render_picture(film: Film, image: Node, *, assume_generated: bool = False) -> PicturePrompt:
    """生图节点 ``image`` 发给模型的描述与参考图。

    ``prompt`` 是一段 ``text:Value`` 时原样发送；是画面模板时按槽的先后一段一段写，每段先写段名，
    段与段之间空一行，没有内容的槽不写。"""

    project = film.project
    prompt = project.nodes[_required(image, "prompt")]
    if not project.is_a(prompt, "Render"):
        return PicturePrompt((prompt.text,), ())
    images: list[tuple[str, str]] = []
    cited: dict[str, list[str]] = {}
    usages: list[str] = []
    for reference in references(project, image):
        target = _required(reference, "image")
        url = film.image_url(target, assume_generated=assume_generated)
        if url is None:
            continue
        images.append((target.partition(".")[0], url))
        mark = f"\x00{len(images)}\x00"
        element = reference.reference("for")
        if element is not None:
            cited.setdefault(element, []).append(mark)
        else:
            usages.append(f"{reference.text.removesuffix('。')}，参考{mark}。")
    elements = element_names(project)
    kit = project.template(_required(prompt, "template"))
    filled = slot_values(project, prompt)
    sections: list[str] = []
    for slot in kit.slots:
        # 槽里的第一段文字和每个元素各开一组，其余的文字接在前一组后面；图号写在组末。
        groups: list[tuple[str | None, str]] = []
        for value in filled[slot.name]:
            name = value.attrs["id"]
            if not groups or name in elements:
                groups.append((name if name in elements else None, value.text))
            else:
                opener, text = groups[-1]
                groups[-1] = (opener, _join(text, value.text))
        pieces = [_cite_sentence(text, cited.get(opener or "", [])) for opener, text in groups]
        if slot.name == PICTURE_SCENE_SLOT:
            pieces += usages
        body = ""
        for piece in pieces:
            body = _join(body, piece)
        if body:
            sections.append(body if slot.label is None else f"{slot.label}\n{body}")
    runs: list[str | PictureImage] = []
    for index, piece in enumerate(_MARK.split("\n\n".join(sections))):
        if index % 2:
            number = int(piece)
            name, url = images[number - 1]
            runs.append(PictureImage(name, url, number))
        elif piece:
            runs.append(piece)
    return PicturePrompt(tuple(runs), tuple(url for _, url in images))


def render_video(film: Film, video: Node, *, assume_generated: bool = False) -> ShotGroup:
    """视频节点发给模型的镜头组：全局设定加逐镜时间线；镜头时间照文件里写的，不换算。

    全局设定三段，段与段之间空一行：拍摄与剪辑；人物、产品、场景每项一行；声音每项一行。"""

    project = film.project
    uses, images = video_images(film, video, assume_generated=assume_generated)
    numbers = {use.holder: use.number for use in uses if use.number is not None}
    filled = slot_values(project, project.nodes[_required(video, "prompt")])
    cast: list[str] = []
    for slot in VIDEO_ELEMENT_SLOTS:
        for value in filled[slot]:
            name = value.attrs["id"]
            marks = [
                f"@Image{numbers[reference]}"
                for reference in references(project, video)
                if reference.reference("for") == name and reference in numbers
            ]
            cast.append(f"{slot} {name}：{_cite_line(value.text, marks)}")
    sections = [
        "\n".join(value.text for value in filled[VIDEO_SHOOTING_SLOT]),
        "\n".join(cast),
        "\n".join(f"{VIDEO_VOICE_SLOT} {value.text}" for value in filled[VIDEO_VOICE_SLOT]),
    ]
    shots = project.kids(video_shots(project, video), "Shot")
    timeline: list[ShotCut] = []
    for shot in shots:
        text = LINE_REFERENCE.sub(
            lambda found: "{" + film.lines[found.group(1)].text + "}", shot.text
        )
        if shot in numbers:
            text = f"参考@Image{numbers[shot]}，{text}"
        timeline.append(ShotCut((float(shot.attrs["start"]), float(shot.attrs["end"])), text))
    return ShotGroup(
        global_settings="\n\n".join(section for section in sections if section),
        timeline=tuple(timeline),
        image_urls=tuple(images),
        seconds=math.ceil(float(shots[-1].attrs["end"])),
    )


def video_images(
    film: Film, video: Node, *, assume_generated: bool = False
) -> tuple[list[ImageUse], list[str]]:
    """视频节点用到的图，按发给视频的先后：先是节点下列的参考图，再是各镜的机位图，地址与前面
    相同的共用编号。只给有图的编号。

    返回 (每一处写了图的地方, 按编号排好的地址)。"""

    project = film.project
    uses: list[ImageUse] = []
    images: list[str] = []
    for reference in references(project, video):
        target = _required(reference, "image")
        url = film.image_url(target, assume_generated=assume_generated)
        if url is not None:
            images.append(url)
        number = len(images) if url is not None else None
        uses.append(ImageUse(reference, target.partition(".")[0], url, number))
    for shot in project.kids(video_shots(project, video), "Shot"):
        target = shot.reference("view")
        if target is None:
            continue
        url = film.image_url(target, assume_generated=assume_generated)
        if url is not None and url not in images:
            images.append(url)
        number = images.index(url) + 1 if url is not None else None
        uses.append(ImageUse(shot, target.partition(".")[0], url, number))
    return uses, images


def video_row(film: Film, video: Node, index: int) -> VideoShotDocumentRow:
    """一个视频节点发给视频模型的那一组：拼好的镜头组、现在有图的参考图、时长，``index`` 是组号。"""

    group = render_video(film, video)
    return VideoShotDocumentRow(
        index=index,
        prompt=StoredVideoShotPrompt(
            global_settings=group.global_settings,
            timeline=[
                StoredTimelineItem(
                    timestamps=list(cut.timestamps),
                    prompt=cut.prompt,
                    image_indexes=image_indexes_of(cut.prompt),
                )
                for cut in group.timeline
            ],
        ),
        seconds=int(video.attrs["duration"]),
        image_urls=list(group.image_urls),
    )


def _ended(text: str) -> str:
    """末尾没有句末标点的补「。」。"""

    return text if not text or text[-1] in _SENTENCE_END else text + "。"


def _join(left: str, right: str) -> str:
    """两段文字接起来：前一段末尾补句末标点；前一段以英文标点结尾时空一格。"""

    if not left or not right:
        return left or right
    left = _ended(left)
    return left + (" " if left[-1] in _LATIN_END else "") + right


def _cite_sentence(text: str, marks: list[str]) -> str:
    """生图描述里的一组：有图时组末写「参考@ImageN。」，没图只补句末标点。"""

    if not marks:
        return _ended(text)
    cite = f"参考{'、'.join(marks)}。"
    if not text:
        return cite
    if text[-1] not in _SENTENCE_END:
        return f"{text}，{cite}"
    return text + (" " if text[-1] in _LATIN_END else "") + cite


def _cite_line(text: str, marks: list[str]) -> str:
    """视频全局设定里一个元素的描述：有图时行尾接「参考@ImageN」，不加句号。"""

    if not marks:
        return text
    cite = f"参考{'、'.join(marks)}"
    return text + cite if text and text[-1] in _SENTENCE_END else f"{text}，{cite}"


def _required(node: Node, name: str) -> str:
    reference = node.reference(name)
    assert reference is not None, f"{node.tag} 的 {name} 在读文件时已经查过"
    return reference


__all__ = [
    "LINE_REFERENCE",
    "ImageUse",
    "PictureImage",
    "PicturePrompt",
    "ShotCut",
    "ShotGroup",
    "element_names",
    "is_kit",
    "references",
    "render_picture",
    "render_video",
    "slot_values",
    "video_images",
    "video_row",
    "video_shots",
]
