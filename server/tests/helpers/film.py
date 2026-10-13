"""工程文件与运行文件的样例，供运行时、工具和制作页的测试共用。

样例是方案的统一示例（``film_example/``，原样）：一条 33 秒的鞋款片拆成 18 秒、15 秒两组视频，
每组三镜。用户给了五张照片（模特A 半身、全身，鞋侧面、鞋头、鞋底），模特B 和街区各生成一张设定图，
每镜一张机位图。四种选用状态各有一份运行文件：``both`` 全部选用；``no-view04`` 取消 view04，工程
文件里 video02 的列表和镜头 1 开头跟着改；``no-personB`` 取消 personB，工程文件不变；``none`` 两张
都取消。``no-personB`` 的工程文件与 ``both`` 逐字相同、``none`` 的与 ``no-view04`` 逐字相同，所以
工程文件只存两份。``expected.json`` 是方案按规则拼好的预期请求：每张图的 ``prompt`` 与
``input_str_list``，每种状态下每组视频的 ``shot`` 与按编号排的参考图，或它被缺图拦住、缺哪几张。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Final, NoReturn

_EXAMPLE: Final = Path(__file__).parent / "film_example"

STATES: Final = ("both", "no-view04", "no-personB", "none")

_PROJECTS: Final = {
    "both": "film-both.icml",
    "no-view04": "film-no-view04.icml",
    "no-personB": "film-both.icml",
    "none": "film-no-view04.icml",
}


def project_of(state: str) -> str:
    """这种选用状态下的工程文件。"""

    return (_EXAMPLE / _PROJECTS[state]).read_text(encoding="utf-8")


def run_of(state: str) -> str:
    """这种选用状态下的运行文件。"""

    return (_EXAMPLE / f"run-{state}.icrun").read_text(encoding="utf-8")


FILM: Final = project_of("both")
RUN: Final = run_of("both")
FILM_NO_VIEW04: Final = project_of("no-view04")
RUN_NO_VIEW04: Final = run_of("no-view04")

EXPECTED: Final[dict[str, Any]] = json.loads(
    (_EXAMPLE / "expected.json").read_text(encoding="utf-8")
)

PHOTOS: Final = {
    "modelAPortraitPhoto": "https://mmt-aigc-sz-public.oss-cn-shenzhen.aliyuncs.com/iclip/agent/uploads/d4c4ce47-9e3b-4cde-80ee-cf1062a43d6e.jpg",
    "modelAFullBodyPhoto": "https://preview.invalid/uploads/modelAFullBodyPhoto.jpg",
    "shoeSidePhoto": "https://mmt-aigc-sz-public.oss-cn-shenzhen.aliyuncs.com/iclip/agent/uploads/6383e34c-9c74-4ea4-b546-de95ba70789d.jpg",
    "shoeFrontPhoto": "https://preview.invalid/uploads/shoeFrontPhoto.jpg",
    "shoeSolePhoto": "https://preview.invalid/uploads/shoeSolePhoto.jpg",
}
"""工程文件里用户给的照片：节点名 → 地址。"""

IMAGE_NODES: Final = (
    "personB",
    "scene",
    "view01",
    "view02",
    "view03",
    "view04",
    "view05",
    "view06",
)
"""工程文件里的生图节点，按先后。"""

GENERATED: Final = {
    node: f"https://preview.invalid/generated/{node}-v1.png" for node in IMAGE_NODES
}
"""运行文件里登记的图：每个生图节点一张，登记名是「节点名-v1」。"""

GIVEN_IMAGES: Final = (*PHOTOS.values(), *GENERATED.values())
"""两个文件里写了地址的图，工具和制作页的测试把它们登记成对话素材。"""

SHOE_FRONT: Final = PHOTOS["shoeFrontPhoto"]

VIEW04: Final = GENERATED["view04"]


class UnusedFilmPage:
    """对话服务要一个制作页端口；测试用不到它时传这个，被调用就算测试写错了。"""

    async def view(self, *_: object, **__: object) -> NoReturn:
        raise AssertionError("这里用不到制作页")

    async def edit_text(self, *_: object, **__: object) -> NoReturn:
        raise AssertionError("这里用不到制作页")

    async def choose_image(self, *_: object, **__: object) -> NoReturn:
        raise AssertionError("这里用不到制作页")

    async def generate_image(self, *_: object, **__: object) -> NoReturn:
        raise AssertionError("这里用不到制作页")

    async def generate_video(self, *_: object, **__: object) -> NoReturn:
        raise AssertionError("这里用不到制作页")


__all__ = [
    "EXPECTED",
    "FILM",
    "FILM_NO_VIEW04",
    "GENERATED",
    "GIVEN_IMAGES",
    "IMAGE_NODES",
    "PHOTOS",
    "RUN",
    "RUN_NO_VIEW04",
    "SHOE_FRONT",
    "STATES",
    "VIEW04",
    "UnusedFilmPage",
    "project_of",
    "run_of",
]
