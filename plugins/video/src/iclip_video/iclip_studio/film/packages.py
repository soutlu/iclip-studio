from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Final, Literal

from iclip_video.shot_rules import MAX_PROMPT_CHARS

ValueType = Literal["文字", "图", "视频", "模板"]

TEXT: Final[ValueType] = "文字"
IMAGE: Final[ValueType] = "图"
VIDEO: Final[ValueType] = "视频"
TEMPLATE: Final[ValueType] = "模板"

AttrKind = Literal["id", "literal", "enum", "int", "seconds", "ref"]


@dataclass(frozen=True, slots=True)
class Attr:
    name: str
    kind: AttrKind
    required: bool = True
    values: tuple[str, ...] = ()
    type: ValueType | None = None


@dataclass(frozen=True, slots=True)
class Generation:
    gateway: str

    max_references: int
    max_prompt_chars: int


@dataclass(frozen=True, slots=True)
class Tag:
    name: str
    attrs: tuple[Attr, ...] = ()
    children: Mapping[str, tuple[int, int | None]] = field(
        default_factory=dict[str, tuple[int, int | None]]
    )

    body: bool = False

    output: tuple[str, ValueType] | None = None

    top: bool = True

    preamble: bool = False

    generation: Generation | None = None


@dataclass(frozen=True, slots=True)
class Package:
    name: str
    version: int
    tags: tuple[Tag, ...]

    bare: bool = False

    @property
    def ref(self) -> str:
        return f"{self.name}@{self.version}"


PROJECT_MARKUP: Final = "@iclip/markup@1"
RUN_MARKUP: Final = "@iclip/run-markup@1"
PROJECT_ROOT: Final = "icml"
RUN_ROOT: Final = "icrun"

IMAGE_MAX_REFERENCES: Final = 10

VIDEO_MAX_REFERENCES: Final = 30

GPT_IMAGE_MODEL: Final = "gpt-image-2.5"

GPT_IMAGE_ASPECTS: Final = ("1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9")
GPT_IMAGE_RESOLUTIONS: Final = ("2k",)

SEEDANCE_VARIANTS: Final[Mapping[str, tuple[str, int, int]]] = {
    "sd2.5": ("mmt-seedance-2-5", 4, 30)
}

VIDEO_ASPECTS: Final = ("9:16", "16:9", "1:1", "4:3", "3:4", "21:9")

SCRIPT_TAG: Final = "script"

TEXT_PACKAGE: Final = Package(
    "@iclip/text",
    1,
    (
        Tag("Value", (Attr("id", "id"),), body=True, output=("", TEXT)),
        Tag(
            "Render",
            (Attr("id", "id"), Attr("template", "ref", type=TEMPLATE)),
            {"Set": (0, None), "Append": (0, None)},
            output=("", TEXT),
        ),
        Tag("Set", (Attr("name", "literal"), Attr("text", "ref", type=TEXT)), top=False),
        Tag("Append", (Attr("name", "literal"), Attr("text", "ref", type=TEXT)), top=False),
    ),
)

MEDIA_PACKAGE: Final = Package(
    "@iclip/media",
    1,
    (Tag("Image", (Attr("id", "id"), Attr("src", "literal")), output=("", IMAGE)),),
)

SCRIPT_PACKAGE: Final = Package(
    "@iclip/script",
    1,
    (Tag(SCRIPT_TAG, (Attr("id", "id"),), body=True),),
    bare=True,
)

DIRECTOR_PACKAGE: Final = Package(
    "@iclip/director",
    2,
    (
        Tag("Shots", (Attr("id", "id"),), {"Shot": (1, None)}, output=("", TEXT)),
        Tag(
            "Shot",
            (
                Attr("start", "seconds"),
                Attr("end", "seconds"),
                Attr("view", "ref", required=False, type=IMAGE),
            ),
            body=True,
            top=False,
        ),
    ),
)

GPT_IMAGE_PACKAGE: Final = Package(
    "@iclip/gpt-image",
    1,
    (
        Tag(
            "Image",
            (
                Attr("id", "id"),
                Attr("prompt", "ref", type=TEXT),
                Attr("aspect-ratio", "enum", values=GPT_IMAGE_ASPECTS),
                Attr("resolution", "enum", values=GPT_IMAGE_RESOLUTIONS),
            ),
            {"Reference": (0, None)},
            output=("image", IMAGE),
            generation=Generation(GPT_IMAGE_MODEL, IMAGE_MAX_REFERENCES, MAX_PROMPT_CHARS),
        ),
        Tag("Reference", (Attr("image", "ref", type=IMAGE),), top=False),
    ),
)

SEEDANCE_PACKAGE: Final = Package(
    "@iclip/seedance",
    1,
    (
        Tag(
            "ReferenceVideo",
            (
                Attr("id", "id"),
                Attr("model", "enum", values=tuple(SEEDANCE_VARIANTS)),
                Attr("prompt", "ref", type=TEXT),
                Attr("duration", "int"),
                Attr("aspect-ratio", "enum", values=VIDEO_ASPECTS),
            ),
            {"Reference": (0, None)},
            output=("video", VIDEO),
            generation=Generation("", VIDEO_MAX_REFERENCES, MAX_PROMPT_CHARS),
        ),
        Tag("Reference", (Attr("image", "ref", type=IMAGE),), top=False),
    ),
)

PROJECT_PACKAGES: Final[Mapping[str, Package]] = {
    package.ref: package
    for package in (
        TEXT_PACKAGE,
        MEDIA_PACKAGE,
        SCRIPT_PACKAGE,
        DIRECTOR_PACKAGE,
        GPT_IMAGE_PACKAGE,
        SEEDANCE_PACKAGE,
    )
}

RUN_PACKAGES: Final[Mapping[str, Package]] = {MEDIA_PACKAGE.ref: MEDIA_PACKAGE}

RUN_TAGS: Final = (
    Tag("film", (Attr("source", "literal"),), preamble=True),
    Tag("use", (Attr("output", "literal"), Attr("image", "ref", type=IMAGE))),
)

__all__ = [
    "DIRECTOR_PACKAGE",
    "GPT_IMAGE_ASPECTS",
    "GPT_IMAGE_MODEL",
    "GPT_IMAGE_PACKAGE",
    "GPT_IMAGE_RESOLUTIONS",
    "IMAGE",
    "IMAGE_MAX_REFERENCES",
    "MEDIA_PACKAGE",
    "PROJECT_MARKUP",
    "PROJECT_PACKAGES",
    "PROJECT_ROOT",
    "RUN_MARKUP",
    "RUN_PACKAGES",
    "RUN_ROOT",
    "RUN_TAGS",
    "SCRIPT_PACKAGE",
    "SCRIPT_TAG",
    "SEEDANCE_PACKAGE",
    "SEEDANCE_VARIANTS",
    "TEMPLATE",
    "TEXT",
    "TEXT_PACKAGE",
    "VIDEO",
    "VIDEO_ASPECTS",
    "VIDEO_MAX_REFERENCES",
    "Attr",
    "Generation",
    "Package",
    "Tag",
    "ValueType",
]
