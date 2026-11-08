from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Final

from iclip_video.iclip_studio.film.document import Document
from iclip_video.iclip_studio.film.film import Film
from iclip_video.iclip_studio.film.kits import (
    VIDEO_SETTING_SLOTS,
    VIDEO_SHOTS_SLOT,
)
from iclip_video.iclip_studio.film.markup import Node
from iclip_video.shot_document import (
    StoredTimelineItem,
    StoredVideoShotPrompt,
    VideoShotDocumentRow,
)
from iclip_video.shot_rules import image_indexes_of

LINE_REFERENCE: Final = re.compile(r"\{([^{}]*)\}")

IMAGE_NUMBER: Final = re.compile(r"@Image([1-9]\d*)")

_SENTENCE_END: Final = "。！？.!?…」）)"
_LATIN_END: Final = ".!?)"


@dataclass(frozen=True, slots=True)
class ListedImage:
    image: str

    url: str | None


@dataclass(frozen=True, slots=True)
class PictureImage:
    image: str

    url: str | None

    number: int


class _Listed:
    __slots__ = ()
    images: tuple[ListedImage, ...]

    @property
    def missing(self) -> tuple[str, ...]:
        return tuple(item.image for item in self.images if item.url is None)

    @property
    def image_urls(self) -> tuple[str, ...]:
        urls = tuple(item.url for item in self.images if item.url is not None)
        if len(urls) != len(self.images):
            raise RuntimeError(f"参考图 {'、'.join(self.missing)} 没有图，不能发送")
        return urls


@dataclass(frozen=True, slots=True)
class PicturePrompt(_Listed):
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
    global_settings: str
    timeline: tuple[ShotCut, ...]
    images: tuple[ListedImage, ...]
    seconds: int


def slot_values(project: Document, render: Node) -> dict[str, list[Node]]:
    kit = project.template(_required(render, "template"))
    filled: dict[str, list[Node]] = {slot.name: [] for slot in kit.slots}
    for child in render.children:
        if project.is_a(child, "Set") or project.is_a(child, "Append"):
            value = project.nodes[_required(child, "text")]
            filled.setdefault(child.attrs["name"], []).append(value)
    return filled


def references(project: Document, node: Node) -> list[Node]:
    return project.kids(node, "Reference")


def is_kit(project: Document, node: Node, kit: str) -> bool:
    if not project.is_a(node, "Render"):
        return False
    return project.template(_required(node, "template")).name == kit


def video_shots(project: Document, video: Node) -> Node:
    prompt = project.nodes[_required(video, "prompt")]
    return slot_values(project, prompt)[VIDEO_SHOTS_SLOT][0]


def written_texts(project: Document, node: Node) -> list[Node]:
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
    return tuple(
        ListedImage(target.partition(".")[0], film.image_url(target))
        for target in (
            _required(reference, "image") for reference in references(film.project, node)
        )
    )


def render_picture(film: Film, image: Node) -> PicturePrompt:
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
    return text if not text or text[-1] in _SENTENCE_END else text + "。"


def _join(left: str, right: str) -> str:
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
