"""工程文件与运行文件的样例，供运行时、工具和制作页的测试共用。

工程文件是规格里的完整示例（``film.icml``，原样）：一条 15 秒的跑鞋片，用户给了跑鞋正面、鞋底
两张照片，人物和跑道各生成一张参考图，每镜一张机位图，一次视频请求。``film-prompts.md`` 是规格
附带的、按规则手写的拼好的提示词，原样。运行文件登记了三张图，给「短发女生参考图」和
「镜01机位图」各选用一张。"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Final, NoReturn

_HERE: Final = Path(__file__).parent

FILM: Final = (_HERE / "film.icml").read_text(encoding="utf-8")
PROMPTS: Final = (_HERE / "film-prompts.md").read_text(encoding="utf-8")

SHOE_FRONT: Final = "https://…/uploads/1f0c2a9e-….jpg"
SHOE_SOLE: Final = "https://…/uploads/7b3e5d10-….jpg"
PERSON_FIRST: Final = "https://cdn.test/a.png"
PERSON_FIXED: Final = "https://cdn.test/b-fixed.png"
VIEW_ONE: Final = "https://cdn.test/view01.png"

GIVEN_IMAGES: Final = (SHOE_FRONT, SHOE_SOLE, PERSON_FIRST, PERSON_FIXED, VIEW_ONE)
"""两个文件里写了地址的图，工具和制作页的测试把它们登记成对话素材。"""

IMAGE_NODES: Final = (
    "短发女生参考图",
    "公园跑道参考图",
    "镜01机位图",
    "镜02机位图",
    "镜03机位图",
    "镜04机位图",
)
"""工程文件里的生图节点，按先后。"""

RUN: Final = """<?icml using="@iclip/run-markup@1"?>
<icrun version="1">
  <film source="./film.icml"/>
  <import as="media" from="@iclip/media@1"/>

  <media:Image id="短发女生第一版" src="https://cdn.test/a.png"/>
  <media:Image id="短发女生修过手" src="https://cdn.test/b-fixed.png"/>
  <media:Image id="镜01第一版" src="https://cdn.test/view01.png"/>

  <use output="短发女生参考图.image" image={短发女生修过手}/>
  <use output="镜01机位图.image" image={镜01第一版}/>
</icrun>
"""

SECOND_REQUEST: Final = """  <film:Shots id="后半镜头">
    <film:Shot start="0.0" end="16.0" view={镜01机位图.image}>硬切，固定机位，产品特写。网面跑鞋放在桌面上，缓慢转动一圈。音效：鞋底落在桌面上的一声轻响</film:Shot>
  </film:Shots>
  <text:Render id="后半提示词" template={kit.多镜头视频-v1}>
    <text:Set name="拍摄与剪辑" text={拍摄与剪辑}/>
    <text:Set name="产品" text={网面跑鞋}/>
    <text:Set name="镜头" text={后半镜头}/>
  </text:Render>
  <seedance:ReferenceVideo id="后半" model="sd2.5" prompt={后半提示词} duration="16" aspect-ratio="9:16">
    <seedance:Reference image={跑鞋正面} for={网面跑鞋}/>
  </seedance:ReferenceVideo>
</icml>
"""
"""接在工程文件末尾的第二次视频请求，时间从 0.0 开始，机位图借用第一组的镜01机位图。"""


def two_requests() -> str:
    """把样例改成 36 秒、拆成两次视频请求的工程文件。"""

    first = FILM.replace(
        '<film:Shot start="10.0" end="15.0"', '<film:Shot start="10.0" end="20.0"'
    ).replace('duration="15"', 'duration="20"')
    return first.replace("</icml>\n", SECOND_REQUEST)


def expected_prompt(case: str, title: str) -> tuple[str, tuple[str, ...]]:
    """``film-prompts.md`` 里一张图或一次视频拼好的全文，和按编号排的参考图节点名。

    ``case`` 是「一」（所有图都已生成）或「二」（短发女生参考图、镜02机位图还没生成），
    ``title`` 是小标题，如「生图：镜02机位图」。"""

    section = PROMPTS.split(f"\n## {case}、", 1)[1].split("\n## ", 1)[0]
    for block in section.split("\n### ")[1:]:
        if block.splitlines()[0].startswith(title):
            text = re.search(r"```\n(.*?)\n```", block, re.S)
            listed = re.search(r"参考图：(.+)", block)
            assert text is not None and listed is not None, title
            names = () if listed.group(1) == "无" else listed.group(1).split("、")
            return text.group(1), tuple(name.split(" ", 1)[1] for name in names)
    raise AssertionError(f"film-prompts.md 里没有「{case}」的「{title}」")


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
    "FILM",
    "GIVEN_IMAGES",
    "IMAGE_NODES",
    "PERSON_FIRST",
    "PERSON_FIXED",
    "PROMPTS",
    "RUN",
    "SECOND_REQUEST",
    "SHOE_FRONT",
    "SHOE_SOLE",
    "VIEW_ONE",
    "UnusedFilmPage",
    "expected_prompt",
    "two_requests",
]
