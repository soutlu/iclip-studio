"""模板包 ``@iclip/film-kits``：生图和视频提示词的两份模板，放在后端代码里，不能自己写。

模板文件（``kits/*.svs``）只写槽：名字、先后、必不必填、段名。各段怎么排是每份模板一套写法，
写在 ``prompts`` 里；这里给出那套写法要认的几个槽。"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from importlib import resources
from typing import Final

FILM_KITS: Final = "@iclip/film-kits"
"""模板包的名字，工程文件里写 ``<import as="kit" source="@iclip/film-kits"/>``。"""

PICTURE_KIT: Final = "picture-v1"
"""一张图的提示词。"""

PICTURE_SLOTS: Final = ("capture", "subject", "framing", "setting")
"""画面模板的槽，按拼的先后。"""

VIDEO_KIT: Final = "multi-shot-video-v1"
"""一次视频请求的提示词。"""

VIDEO_CAPTURE_SLOT: Final = "capture"
VIDEO_ELEMENT_SLOTS: Final = ("person", "product", "setting")
"""多镜头视频模板里放出场元素的槽，按拼的先后。"""

VIDEO_AUDIO_SLOT: Final = "audio"
VIDEO_SHOTS_SLOT: Final = "shots"
"""多镜头视频模板里放 ``film:Shots`` 的槽：只 ``Set`` 一个，不 ``Append``。"""

VIDEO_SETTING_SLOTS: Final = (VIDEO_CAPTURE_SLOT, *VIDEO_ELEMENT_SLOTS, VIDEO_AUDIO_SLOT)
"""多镜头视频模板里拼进全局设定的槽，按拼的先后。"""

_HEADER: Final = '<?icml using="@iclip/text/svs@1"?>'
_SHEET: Final = re.compile(r'<sheet version="1" id="([^"]+)">')
_RULE: Final = re.compile(r"text-template\.(?P<path>[^\s{]+)\s*\{(?P<body>[^}]*)\}")
_DECLARATION: Final = re.compile(r'\s*([\w-]+)\s*:\s*("[^"]*"|[^;]*?)\s*;')


@dataclass(frozen=True, slots=True)
class Slot:
    name: str
    required: bool
    label: str
    """拼提示词时这一段的段名，如「capture:」「人物：」。"""

    @property
    def title(self) -> str:
        """给人看的称呼：段名去掉末尾的冒号，如「人物」。"""

        return self.label.rstrip(":：")


@dataclass(frozen=True, slots=True)
class Kit:
    """一份模板：按先后排好的槽。"""

    name: str
    slots: tuple[Slot, ...]

    def slot(self, name: str) -> Slot | None:
        return next((slot for slot in self.slots if slot.name == name), None)


def _read(name: str) -> Kit:
    """读一份模板文件。文件是代码的一部分，写错了直接抛错，服务起不来。"""

    source = resources.files(__package__).joinpath("kits", f"{name}.svs").read_text("utf-8")
    sheet = _SHEET.search(source)
    if not source.startswith(_HEADER) or sheet is None or sheet.group(1) != name:
        raise RuntimeError(f"模板文件 {name}.svs 的文件头或 sheet 不对")
    ordered: list[tuple[int, Slot]] = []
    for rule in _RULE.finditer(source):
        path = rule.group("path").split(".")
        declared = {
            key: value.strip('"') for key, value in _DECLARATION.findall(rule.group("body"))
        }
        if path == [name]:
            # 段与段之间空一行是两份模板共同的排法，写在 prompts 里；这里只核对文件没写别的。
            if declared != {"separator": "paragraph"}:
                raise RuntimeError(f"模板 {name} 的排法不是 separator: paragraph")
            continue
        if len(path) != 3 or path[0] != name or path[1] != "block" or declared["kind"] != "slot":
            raise RuntimeError(f"模板 {name} 里有读不懂的规则：{rule.group(0)}")
        slot = Slot(declared["slot"], declared["optional"] == "false", declared["label"])
        ordered.append((int(declared["order"]), slot))
    return Kit(name, tuple(slot for _, slot in sorted(ordered, key=lambda item: item[0])))


def _kits() -> dict[str, Kit]:
    picture, video = _read(PICTURE_KIT), _read(VIDEO_KIT)
    expected = {picture: PICTURE_SLOTS, video: (*VIDEO_SETTING_SLOTS, VIDEO_SHOTS_SLOT)}
    for kit, names in expected.items():
        if tuple(slot.name for slot in kit.slots) != names:
            raise RuntimeError(f"模板 {kit.name} 的槽要是代码里认的 {'、'.join(names)}")
    return {picture.name: picture, video.name: video}


KITS: Final[Mapping[str, Mapping[str, Kit]]] = {FILM_KITS: _kits()}
"""工程文件能用 ``source`` 引入的模板包：包名 → 模板名 → 模板。"""

__all__ = [
    "FILM_KITS",
    "KITS",
    "PICTURE_KIT",
    "PICTURE_SLOTS",
    "VIDEO_AUDIO_SLOT",
    "VIDEO_CAPTURE_SLOT",
    "VIDEO_ELEMENT_SLOTS",
    "VIDEO_KIT",
    "VIDEO_SETTING_SLOTS",
    "VIDEO_SHOTS_SLOT",
    "Kit",
    "Slot",
]
