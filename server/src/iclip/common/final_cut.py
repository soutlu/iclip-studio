"""final-cut 工程的工作区路径约定、支持导出的目标语言与分辨率档位，以及主文件素材地址解析。"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from html.parser import HTMLParser
from typing import Final, Literal

PROJECT_DIR: Final = "final-cut"

MAIN_FILE: Final = "index.html"

TargetLocale = Literal["zh", "en", "de", "es", "fr"]
"""final-cut 支持扩展的目标语言。原文为视频自有语言（不限语种，无需声明），无语言值表，接口中以 ``null`` 表示；
每种目标语言对应一份值表，路径见 ``locale_path``。"""

LANGUAGE_NAMES: Final[Mapping[TargetLocale, str]] = {
    "zh": "中文",
    "en": "英语",
    "de": "德语",
    "es": "西班牙语",
    "fr": "法语",
}
"""各目标语言的中文名称，用于拼装翻译与配音模型提示词。"""


ExportResolution = Literal["480p", "720p", "1080p"]
"""成片导出可选的分辨率档位，与前端及渲染服务共用的 ``EXPORT_TIERS``
（``web/src/features/storyboard/final-cut/composition/export-resolution.ts``）保持一致。
作为单次导出请求参数传递，不持久化至工程文件；当前画面尺寸是否支持该档位由渲染服务判定。"""


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
        # 与渲染服务保持一致：重复的 src 仅保留首次出现项，无值属性视为空字符串
        for name, value in attrs:
            if name == "src":
                self.found.setdefault(value or "", tag)
                return


def media_addresses(html: str) -> tuple[MediaAddress, ...]:
    """提取主文件中 ``<video>`` 与 ``<audio>`` 元素的 ``src`` 地址，按首次出现顺序去重；
    同一地址以首次出现的元素类型为准。解析规则与渲染服务的 ``mediaAddresses``（``render/src/project.ts``）一致。
    各语种配音片段均以 ``<audio>`` 纳入，渲染服务仅下载目标导出语言实际使用的素材。"""

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
