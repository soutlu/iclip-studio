"""按模板把生成节点的提示词拼出来：``picture-v1`` 拼一张图的描述，``multi-shot-video-v1`` 拼一次
视频请求。

两份模板各有一套写法，只在这里定。文字原样拼，不补任何字：图的编号 ``@ImageN`` 由 AI 导演写在
各节点自己的文字里，N 是图在这个生成节点下 ``Reference`` 列表里的位置；机位图选用时由制作页写进
列表和那一镜的开头。发给模型的参考图就是这份列表，按先后。"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Final

from iclip.capabilities.iclip_studio.film.document import Document
from iclip.capabilities.iclip_studio.film.film import Film
from iclip.capabilities.iclip_studio.film.kits import (
    VIDEO_SETTING_SLOTS,
    VIDEO_SHOTS_SLOT,
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

IMAGE_NUMBER: Final = re.compile(r"@Image([1-9]\d*)")
"""文字里写对了的图号 ``@ImageN``；写法检查见 ``checks``。"""

_SENTENCE_END: Final = "。！？.!?…」）)"
_LATIN_END: Final = ".!?)"
"""以这几个英文标点结尾的文字，后面接别的字先空一格。"""


@dataclass(frozen=True, slots=True)
class ListedImage:
    """生成节点 ``Reference`` 列表里的一张图。"""

    image: str
    """图片节点的名字。"""

    url: str | None
    """现在的地址；生图节点没有选用时为 None。"""


@dataclass(frozen=True, slots=True)
class PictureImage:
    """生图描述里引用的一张参考图。"""

    image: str
    """图片节点的名字。"""

    url: str | None
    """现在的地址；生图节点没有选用时为 None。"""

    number: int
    """在参考图列表里排第几，从 1 起；描述里写成 ``@ImageN``。"""


class _Listed:
    """带参考图列表的拼装结果共有的取法。"""

    __slots__ = ()
    images: tuple[ListedImage, ...]

    @property
    def missing(self) -> tuple[str, ...]:
        """列表里现在没有图的图片节点，按先后；不为空时不能生成。"""

        return tuple(item.image for item in self.images if item.url is None)

    @property
    def image_urls(self) -> tuple[str, ...]:
        """发给模型的参考图地址，按列表先后。调用方先确认 ``missing`` 为空。"""

        urls = tuple(item.url for item in self.images if item.url is not None)
        if len(urls) != len(self.images):
            raise RuntimeError(f"参考图 {'、'.join(self.missing)} 没有图，不能发送")
        return urls


@dataclass(frozen=True, slots=True)
class PicturePrompt(_Listed):
    """一张图的提示词和它的参考图列表。

    ``runs`` 是同一段提示词按 ``@ImageN`` 拆开：文字原样，参考图在它的位置，没有图的也拆出来、
    地址为 None。``text`` 由它拼成。"""

    runs: tuple[str | PictureImage, ...]
    images: tuple[ListedImage, ...]

    @property
    def text(self) -> str:
        return "".join(run if isinstance(run, str) else f"@Image{run.number}" for run in self.runs)


@dataclass(frozen=True, slots=True)
class ShotCut:
    timestamps: tuple[float, float]
    prompt: str


@dataclass(frozen=True, slots=True)
class ShotGroup(_Listed):
    """一次视频请求：与分镜文件里的一个镜头组同形，另带参考图列表和时长。"""

    global_settings: str
    timeline: tuple[ShotCut, ...]
    images: tuple[ListedImage, ...]
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


def video_shots(project: Document, video: Node) -> Node:
    """视频节点提示词「shots」槽里的 ``film:Shots``。"""

    prompt = project.nodes[_required(video, "prompt")]
    return slot_values(project, prompt)[VIDEO_SHOTS_SLOT][0]


def written_texts(project: Document, node: Node) -> list[Node]:
    """生成节点提示词用到的、写了正文的标签：填进槽里的 ``text:Value``，视频另加每个镜头。只用在
    检查过模板与填槽的文件上。"""

    prompt = project.nodes[_required(node, "prompt")]
    texts: list[Node] = []
    for values in slot_values(project, prompt).values():
        for value in values:
            if project.is_a(value, "Shots"):
                texts += project.kids(value, "Shot")
            else:
                texts.append(value)
    return texts


def listed_images(film: Film, node: Node) -> tuple[ListedImage, ...]:
    """生成节点 ``Reference`` 列表里的图和它们现在的地址，按先后。"""

    return tuple(
        ListedImage(target.partition(".")[0], film.image_url(target))
        for target in (
            _required(reference, "image") for reference in references(film.project, node)
        )
    )


def render_picture(film: Film, image: Node) -> PicturePrompt:
    """生图节点 ``image`` 发给模型的描述与参考图。

    按画面模板的槽的先后一段一段写：每段先写段名再换行，同一个槽的几段文字接成一段，段与段之间
    空一行，没有内容的槽不写。"""

    project = film.project
    prompt = project.nodes[_required(image, "prompt")]
    kit = project.template(_required(prompt, "template"))
    filled = slot_values(project, prompt)
    sections: list[str] = []
    for slot in kit.slots:
        body = ""
        for value in filled[slot.name]:
            body = _join(body, value.text)
        if body:
            sections.append(f"{slot.label}\n{body}")
    images = listed_images(film, image)
    runs: list[str | PictureImage] = []
    for index, piece in enumerate(IMAGE_NUMBER.split("\n\n".join(sections))):
        if index % 2:
            listed = images[int(piece) - 1]
            runs.append(PictureImage(listed.image, listed.url, int(piece)))
        elif piece:
            runs.append(piece)
    return PicturePrompt(tuple(runs), images)


def render_video(film: Film, video: Node) -> ShotGroup:
    """视频节点发给模型的镜头组：全局设定加逐镜时间线；镜头时间照文件里写的，不换算。

    全局设定按模板的槽的先后一段一段写：每段先写段名再换行，同一个槽的几段文字一行一段，段与段
    之间空一行。镜头正文里的 ``{段名}`` 换成 ``{台词}``，其余原样。"""

    project = film.project
    prompt = project.nodes[_required(video, "prompt")]
    kit = project.template(_required(prompt, "template"))
    filled = slot_values(project, prompt)
    sections: list[str] = []
    for name in VIDEO_SETTING_SLOTS:
        slot = kit.slot(name)
        assert slot is not None, f"{name} 在读模板时已经查过"
        body = "\n".join(value.text for value in filled[name])
        if body:
            sections.append(f"{slot.label}\n{body}")
    shots = project.kids(video_shots(project, video), "Shot")
    timeline = tuple(
        ShotCut(
            (float(shot.attrs["start"]), float(shot.attrs["end"])),
            LINE_REFERENCE.sub(
                lambda found: "{" + film.lines[found.group(1)].text + "}", shot.text
            ),
        )
        for shot in shots
    )
    return ShotGroup(
        global_settings="\n\n".join(sections),
        timeline=timeline,
        images=listed_images(film, video),
        seconds=math.ceil(float(shots[-1].attrs["end"])),
    )


def video_row(film: Film, video: Node, index: int) -> VideoShotDocumentRow:
    """一个视频节点发给视频模型的那一组：拼好的镜头组、参考图、时长，``index`` 是组号。调用方先
    确认这组的参考图都有图。"""

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


def _required(node: Node, name: str) -> str:
    reference = node.reference(name)
    assert reference is not None, f"{node.tag} 的 {name} 在读文件时已经查过"
    return reference


__all__ = [
    "IMAGE_NUMBER",
    "LINE_REFERENCE",
    "ListedImage",
    "PictureImage",
    "PicturePrompt",
    "ShotCut",
    "ShotGroup",
    "is_kit",
    "listed_images",
    "references",
    "render_picture",
    "render_video",
    "slot_values",
    "video_row",
    "video_shots",
    "written_texts",
]
