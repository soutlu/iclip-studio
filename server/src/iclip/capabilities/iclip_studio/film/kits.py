"""模板包 ``@iclip/film-kits``：生图和视频提示词的两份模板，放在后端代码里，不能自己写。

模板文件（``kits/*.svs``）只写槽：名字、先后、必不必填、段名，视频的人物、产品、场景另写有图时
冒号后那几个字。各段怎么排、图号写在哪是每份模板一套写法，写在 ``prompts`` 里；这里给出那套
写法要认的几个槽。改模板的槽或排法时在原文件上改，不出新版本，工程文件下次生成时就按新的拼
（ADR-0014）。"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from importlib import resources
from typing import Final

FILM_KITS: Final = "@iclip/film-kits"
"""模板包的名字，工程文件里写 ``<import as="kit" source="@iclip/film-kits"/>``。"""

PICTURE_KIT: Final = "画面-v1"
"""一张图的提示词。"""

VIDEO_KIT: Final = "多镜头视频-v1"
"""一次视频请求的提示词。"""

PICTURE_SCENE_SLOT: Final = "场景"
"""画面模板里，用途图那几句接在这个槽的末尾。"""

VIDEO_SHOOTING_SLOT: Final = "拍摄与剪辑"
VIDEO_ELEMENT_SLOTS: Final = ("人物", "产品", "场景")
"""多镜头视频模板里放出场元素的槽，按拼的先后。"""

VIDEO_VOICE_SLOT: Final = "声音"
VIDEO_SHOTS_SLOT: Final = "镜头"
"""多镜头视频模板里放 ``film:Shots`` 的槽：只 ``Set`` 一个，不 ``Append``。"""

_HEADER: Final = '<?icml using="@iclip/text/svs@1"?>'
_SHEET: Final = re.compile(r'<sheet version="1" id="([^"]+)">')
_RULE: Final = re.compile(r"text-template\.(?P<path>[^\s{]+)\s*\{(?P<body>[^}]*)\}")
_DECLARATION: Final = re.compile(r'\s*([\w-]+)\s*:\s*("[^"]*"|[^;]*?)\s*;')


@dataclass(frozen=True, slots=True)
class Slot:
    name: str
    required: bool
    label: str | None
    """拼提示词时这一段的段名，如「拍摄：」；不写段名的为 None。"""

    cite: str | None
    """视频提示词里这个槽的元素有图时，冒号后只写这几个字再接图号，如「外观」；不写的为 None。"""


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
        slot = Slot(
            declared["slot"],
            declared["optional"] == "false",
            declared.get("label"),
            declared.get("cite"),
        )
        ordered.append((int(declared["order"]), slot))
    return Kit(name, tuple(slot for _, slot in sorted(ordered, key=lambda item: item[0])))


def _kits() -> dict[str, Kit]:
    picture, video = _read(PICTURE_KIT), _read(VIDEO_KIT)
    expected = {
        picture: (PICTURE_SCENE_SLOT,),
        video: (VIDEO_SHOOTING_SLOT, *VIDEO_ELEMENT_SLOTS, VIDEO_VOICE_SLOT, VIDEO_SHOTS_SLOT),
    }
    for kit, names in expected.items():
        missing = [name for name in names if kit.slot(name) is None]
        if missing:
            raise RuntimeError(f"模板 {kit.name} 缺代码里要认的槽：{'、'.join(missing)}")
    uncited = [
        slot.name for slot in video.slots if slot.name in VIDEO_ELEMENT_SLOTS and slot.cite is None
    ]
    if uncited:
        raise RuntimeError(f"模板 {video.name} 的槽没写 cite：{'、'.join(uncited)}")
    return {picture.name: picture, video.name: video}


KITS: Final[Mapping[str, Mapping[str, Kit]]] = {FILM_KITS: _kits()}
"""工程文件能用 ``source`` 引入的模板包：包名 → 模板名 → 模板。"""

__all__ = [
    "FILM_KITS",
    "KITS",
    "PICTURE_KIT",
    "PICTURE_SCENE_SLOT",
    "VIDEO_ELEMENT_SLOTS",
    "VIDEO_KIT",
    "VIDEO_SHOOTING_SLOT",
    "VIDEO_SHOTS_SLOT",
    "VIDEO_VOICE_SLOT",
    "Kit",
    "Slot",
]
