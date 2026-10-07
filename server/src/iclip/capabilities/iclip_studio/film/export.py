"""从检查通过的工程文件导出分镜文件，以及列出每个生图节点现在用哪张图。"""

from __future__ import annotations

from dataclasses import dataclass

from iclip.capabilities.iclip_studio.film.film import FILM_PATH, Film
from iclip.capabilities.iclip_studio.film.markup import Node
from iclip.capabilities.iclip_studio.film.packages import SEEDANCE_VARIANTS
from iclip.capabilities.iclip_studio.film.prompts import render_storyboard
from iclip.capabilities.shot_document import (
    StoredTimelineItem,
    StoredVideoShotPrompt,
    VideoShotDocumentRow,
    VideoShotsDocument,
)
from iclip.common.shot_rules import image_indexes_of


class NothingToExport(ValueError):
    """工程文件里没有视频节点。"""


@dataclass(frozen=True, slots=True)
class NodeImage:
    """一个生图节点现在用的图。"""

    name: str
    source: str
    """图从哪来，给人看的一句话。"""

    url: str | None


def export_shots(film: Film) -> VideoShotsDocument:
    """每个视频节点导出成一个镜头组，顺序与文件里相同；镜头的时间原样照搬。

    只放现在有图的参考图。``film`` 要已经检查通过。"""

    videos = film.project.find("ReferenceVideo")
    if not videos:
        raise NothingToExport(f"{FILM_PATH} 里没有视频节点，导不出分镜")
    return VideoShotsDocument(
        aspect_ratio=videos[0].attrs["aspect-ratio"],
        shots=[video_row(film, video, index) for index, video in enumerate(videos, start=1)],
    )


def image_status(film: Film) -> list[NodeImage]:
    """每个生图节点现在用哪张图，按文件里的先后。"""

    status: list[NodeImage] = []
    for node in film.image_nodes():
        name = node.attrs["id"]
        chosen = film.selected.get(name)
        latest = film.generated.get(name)
        if chosen is not None:
            status.append(NodeImage(name, f"运行文件选用「{chosen}」", film.registered[chosen]))
        elif latest is not None:
            status.append(NodeImage(name, "最近一次生成", latest))
        else:
            status.append(NodeImage(name, "还没有图", None))
    return status


def video_row(film: Film, video: Node, index: int) -> VideoShotDocumentRow:
    """一个视频节点发给视频模型的那一组：拼好的镜头组、现在有图的参考图、时长，``index`` 是组号。

    导出分镜和制作页出片用的是同一份。"""

    reference = video.reference("prompt")
    assert reference is not None
    group = render_storyboard(film, film.project.nodes[reference])
    return VideoShotDocumentRow(
        index=index,
        model=SEEDANCE_VARIANTS[video.attrs["model"]][0],
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


__all__ = ["NodeImage", "NothingToExport", "export_shots", "image_status", "video_row"]
