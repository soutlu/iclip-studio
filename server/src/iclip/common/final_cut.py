"""final-cut 工程在工作区里的位置，和从主文件里取素材地址。"""

from __future__ import annotations

from dataclasses import dataclass
from html.parser import HTMLParser
from typing import Final, Literal

PROJECT_DIR: Final = "final-cut"

MAIN_FILE: Final = "index.html"

MediaKind = Literal["video", "audio"]


@dataclass(frozen=True, slots=True)
class MediaAddress:
    """主文件里一个 ``<video>`` 或 ``<audio>`` 的 ``src``。"""

    url: str
    kind: MediaKind


class _MediaCollector(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.found: dict[str, MediaKind] = {}

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != "video" and tag != "audio":
            return
        # 和渲染服务一样：重复的 src 取第一个，不带值的 src 算空串
        for name, value in attrs:
            if name == "src":
                self.found.setdefault(value or "", tag)
                return


def media_addresses(html: str) -> tuple[MediaAddress, ...]:
    """主文件里 ``<video>``、``<audio>`` 的 ``src`` 写的素材地址，按出现先后、不重复；同一个地址
    先出现在哪种元素上就算哪种。规则同渲染服务的 ``mediaAddresses``（``render/src/project.ts``）。"""

    collector = _MediaCollector()
    collector.feed(html)
    collector.close()
    return tuple(MediaAddress(url=url, kind=kind) for url, kind in collector.found.items())


__all__ = ["MAIN_FILE", "PROJECT_DIR", "MediaAddress", "MediaKind", "media_addresses"]
