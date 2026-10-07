"""包声明：每个包有哪些标签，标签收哪些属性和子标签，产出什么类型。

检查按这份声明进行；文件里没有 import 的包，它的标签不认识。类型属于语言本身：模型包只认
「提示词」和「图」，不依赖 director 包。加一个模型只加一个包。"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Final, Literal

ValueType = Literal["文字", "图", "视频", "提示词", "出场元素", "台词"]

TEXT: Final[ValueType] = "文字"
IMAGE: Final[ValueType] = "图"
VIDEO: Final[ValueType] = "视频"
PROMPT: Final[ValueType] = "提示词"
ELEMENT: Final[ValueType] = "出场元素"
LINE: Final[ValueType] = "台词"

AttrKind = Literal["id", "literal", "enum", "int", "seconds", "ref"]


@dataclass(frozen=True, slots=True)
class Attr:
    """一个属性：``ref`` 要写成 ``属性={名字}`` 并指明要什么类型，其余都是带引号的普通值。"""

    name: str
    kind: AttrKind
    required: bool = True
    values: tuple[str, ...] = ()
    type: ValueType | None = None


@dataclass(frozen=True, slots=True)
class Generation:
    """生成节点发给模型时的名字和上限。"""

    gateway: str
    """我们这边的模型名：生图是生成域的 provider 名，视频是制作页出片栏默认选的视频模型名。"""

    max_references: int
    max_prompt_chars: int


@dataclass(frozen=True, slots=True)
class Tag:
    name: str
    attrs: tuple[Attr, ...] = ()
    children: Mapping[str, tuple[int, int | None]] = field(
        default_factory=dict[str, tuple[int, int | None]]
    )
    """能写哪些子标签，各自最少、最多几个；最多为 None 是不限。"""

    body: bool = False
    """收不收正文。"""

    output: tuple[str, ValueType] | None = None
    """输出的路径和类型；路径为空串表示引用时写 ``{id}``，否则写 ``{id.路径}``。"""

    top: bool = True
    """能不能直接写在根标签下面。"""

    preamble: bool = False
    """写在 import 之前的标签。"""

    generation: Generation | None = None


@dataclass(frozen=True, slots=True)
class Package:
    name: str
    version: int
    tags: tuple[Tag, ...]

    @property
    def ref(self) -> str:
        return f"{self.name}@{self.version}"


PROJECT_MARKUP: Final = "@iclip/markup@1"
RUN_MARKUP: Final = "@iclip/run-markup@1"
PROJECT_ROOT: Final = "icml"
RUN_ROOT: Final = "icrun"

IMAGE_MAX_REFERENCES: Final = 10
"""生成域对所有生图模型的参考图上限；与它不一致由契约测试报出。"""

PROMPT_MAX_CHARS: Final = 4000
"""生成域对提示词的统一上限；与它不一致由契约测试报出。"""

VIDEO_MAX_REFERENCES: Final = 30

GPT_IMAGE_MODEL: Final = "gpt-image-2.5"
"""生成域里这家图片模型的名字。"""

GPT_IMAGE_ASPECTS: Final = ("1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9")
GPT_IMAGE_RESOLUTIONS: Final = ("2k",)
"""文件里只写画幅和分辨率，像素尺寸由生成域换算。能写哪些取值照生成域里这家模型的声明，与它
不一致由契约测试报出。"""

SEEDANCE_VARIANTS: Final[Mapping[str, tuple[str, int, int]]] = {
    "sd2.5": ("mmt-seedance-2-5", 4, 30)
}
"""``model`` 属性的取值 → (出片栏默认选的视频模型名, 最短秒数, 最长秒数)。"""

VIDEO_ASPECTS: Final = ("9:16", "16:9", "1:1", "4:3", "3:4", "21:9")

TEXT_PACKAGE: Final = Package(
    "@iclip/text",
    1,
    (Tag("Value", (Attr("id", "id"),), body=True, output=("", TEXT)),),
)

MEDIA_PACKAGE: Final = Package(
    "@iclip/media",
    1,
    (Tag("Image", (Attr("id", "id"), Attr("src", "literal")), output=("", IMAGE)),),
)

DIRECTOR_PACKAGE: Final = Package(
    "@iclip/director",
    1,
    (
        Tag(
            "Element",
            (Attr("id", "id"), Attr("type", "enum", values=("人物", "产品", "场景"))),
            body=True,
            output=("", ELEMENT),
        ),
        Tag("Voice", (Attr("role", "literal"),), body=True),
        Tag("Script", children={"Line": (1, None)}),
        Tag(
            "Line",
            (Attr("id", "id"), Attr("role", "literal")),
            body=True,
            output=("", LINE),
            top=False,
        ),
        Tag(
            "Picture",
            (Attr("id", "id"),),
            {"Cast": (0, None), "Reference": (0, None), "Block": (0, None)},
            output=("", PROMPT),
        ),
        Tag(
            "Storyboard",
            (Attr("id", "id"),),
            {"Cast": (0, None), "Reference": (0, None), "Block": (1, 1), "Shot": (1, None)},
            output=("", PROMPT),
        ),
        Tag(
            "Cast",
            (
                Attr("element", "ref", type=ELEMENT),
                Attr("image", "ref", required=False, type=IMAGE),
            ),
            top=False,
        ),
        Tag("Reference", (Attr("image", "ref", type=IMAGE),), body=True, top=False),
        Tag(
            "Block",
            (Attr("name", "literal"), Attr("text", "ref", required=False, type=TEXT)),
            body=True,
            top=False,
        ),
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
                Attr("prompt", "ref", type=PROMPT),
                Attr("aspect-ratio", "enum", values=GPT_IMAGE_ASPECTS),
                Attr("resolution", "enum", values=GPT_IMAGE_RESOLUTIONS),
            ),
            output=("image", IMAGE),
            generation=Generation(GPT_IMAGE_MODEL, IMAGE_MAX_REFERENCES, PROMPT_MAX_CHARS),
        ),
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
                Attr("prompt", "ref", type=PROMPT),
                Attr("duration", "int"),
                Attr("aspect-ratio", "enum", values=VIDEO_ASPECTS),
            ),
            output=("video", VIDEO),
            generation=Generation("", VIDEO_MAX_REFERENCES, PROMPT_MAX_CHARS),
        ),
    ),
)

PROJECT_PACKAGES: Final[Mapping[str, Package]] = {
    package.ref: package
    for package in (
        TEXT_PACKAGE,
        MEDIA_PACKAGE,
        DIRECTOR_PACKAGE,
        GPT_IMAGE_PACKAGE,
        SEEDANCE_PACKAGE,
    )
}
"""工程文件能引入的包。"""

RUN_PACKAGES: Final[Mapping[str, Package]] = {MEDIA_PACKAGE.ref: MEDIA_PACKAGE}
"""运行文件能引入的包：只有登记图片用的 media。"""

RUN_TAGS: Final = (
    Tag("film", (Attr("source", "literal"),), preamble=True),
    Tag("use", (Attr("output", "literal"), Attr("image", "ref", type=IMAGE))),
)
"""运行文件自带的两个标签：``film`` 指明对应的工程文件，``use`` 给一个生图节点选用登记的图。"""

__all__ = [
    "DIRECTOR_PACKAGE",
    "ELEMENT",
    "GPT_IMAGE_ASPECTS",
    "GPT_IMAGE_MODEL",
    "GPT_IMAGE_PACKAGE",
    "GPT_IMAGE_RESOLUTIONS",
    "IMAGE",
    "IMAGE_MAX_REFERENCES",
    "LINE",
    "MEDIA_PACKAGE",
    "PROJECT_MARKUP",
    "PROJECT_PACKAGES",
    "PROJECT_ROOT",
    "PROMPT",
    "PROMPT_MAX_CHARS",
    "RUN_MARKUP",
    "RUN_PACKAGES",
    "RUN_ROOT",
    "RUN_TAGS",
    "SEEDANCE_PACKAGE",
    "SEEDANCE_VARIANTS",
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
