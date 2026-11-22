"""final-cut 工程在工作区里的位置、它能加的语言，和从主文件里取素材地址。"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from html.parser import HTMLParser
from typing import Final, Literal

PROJECT_DIR: Final = "final-cut"

MAIN_FILE: Final = "index.html"

TargetLocale = Literal["zh", "en", "de", "es", "fr"]
"""final-cut 能加的语言。原文是视频自带的语言（什么语言都行，不用声明），没有值表，接口里写 null；
能加的每种语言一份值表，见 ``locale_path``。"""

LANGUAGE_NAMES: Final[Mapping[TargetLocale, str]] = {
    "zh": "中文",
    "en": "英语",
    "de": "德语",
    "es": "西班牙语",
    "fr": "法语",
}
"""每种能加的语言的中文名，写进给模型的提示词（翻译、配音）里。"""


ExportResolution = Literal["480p", "720p", "1080p"]
"""成片导出能选的分辨率档位，同前端与渲染服务共用的 ``EXPORT_TIERS``
（``web/src/features/storyboard/final-cut/composition/export-resolution.ts``）。是每次导出的请求参数，不写进
工程；这个画面能不能导这一档由渲染服务判断。"""


def locale_path(locale: TargetLocale) -> str:
    """一种语言的值表在工程里的路径（相对工程根）。"""

    return f"locales/{locale}.json"


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
    先出现在哪种元素上就算哪种。规则同渲染服务的 ``mediaAddresses``（``render/src/project.ts``）。
    各语言的配音片段也是 ``<audio>``，都算在里面；渲染服务只下载导出的那种语言用到的。"""

    collector = _MediaCollector()
    collector.feed(html)
    collector.close()
    return tuple(MediaAddress(url=url, kind=kind) for url, kind in collector.found.items())


__all__ = [
    "LANGUAGE_NAMES",
    "MAIN_FILE",
    "PROJECT_DIR",
    "ExportResolution",
    "MediaAddress",
    "MediaKind",
    "TargetLocale",
    "locale_path",
    "media_addresses",
]
