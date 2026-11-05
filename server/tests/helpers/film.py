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
    return (_EXAMPLE / _PROJECTS[state]).read_text(encoding="utf-8")


def run_of(state: str) -> str:
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

GENERATED: Final = {
    node: f"https://preview.invalid/generated/{node}-v1.png" for node in IMAGE_NODES
}

GIVEN_IMAGES: Final = (*PHOTOS.values(), *GENERATED.values())

SHOE_FRONT: Final = PHOTOS["shoeFrontPhoto"]

VIEW04: Final = GENERATED["view04"]


class UnusedFilmPage:
    async def view(self, *_: object, **__: object) -> NoReturn:
        raise AssertionError("这里用不到制作页")

    async def edit_text(self, *_: object, **__: object) -> NoReturn:
        raise AssertionError("这里用不到制作页")

    async def choose_image(self, *_: object, **__: object) -> NoReturn:
        raise AssertionError("这里用不到制作页")

    async def set_aspect_ratio(self, *_: object, **__: object) -> NoReturn:
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
