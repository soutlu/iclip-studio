from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from importlib import resources
from typing import Final

FILM_KITS: Final = "@iclip/film-kits"

PICTURE_KIT: Final = "picture-v1"

PICTURE_SLOTS: Final = ("capture", "subject", "framing", "setting")

VIDEO_KIT: Final = "multi-shot-video-v1"

VIDEO_CAPTURE_SLOT: Final = "capture"
VIDEO_ELEMENT_SLOTS: Final = ("person", "product", "setting")

VIDEO_AUDIO_SLOT: Final = "audio"
VIDEO_SHOTS_SLOT: Final = "shots"

VIDEO_SETTING_SLOTS: Final = (VIDEO_CAPTURE_SLOT, *VIDEO_ELEMENT_SLOTS, VIDEO_AUDIO_SLOT)

_HEADER: Final = '<?icml using="@iclip/text/svs@1"?>'
_SHEET: Final = re.compile(r'<sheet version="1" id="([^"]+)">')
_RULE: Final = re.compile(r"text-template\.(?P<path>[^\s{]+)\s*\{(?P<body>[^}]*)\}")
_DECLARATION: Final = re.compile(r'\s*([\w-]+)\s*:\s*("[^"]*"|[^;]*?)\s*;')


@dataclass(frozen=True, slots=True)
class Slot:
    name: str
    required: bool
    label: str

    @property
    def title(self) -> str:
        return self.label.rstrip(":：")


@dataclass(frozen=True, slots=True)
class Kit:
    name: str
    slots: tuple[Slot, ...]

    def slot(self, name: str) -> Slot | None:
        return next((slot for slot in self.slots if slot.name == name), None)


def _read(name: str) -> Kit:
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
