from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

FrameKind = Literal["generated", "photo"]

SettingKind = Literal["shooting", "element", "voice"]


@dataclass(frozen=True, slots=True)
class FilmPromptText:
    text: str


@dataclass(frozen=True, slots=True)
class FilmPromptImage:
    node: str
    label: str
    url: str | None

    number: int


FilmPromptRun = FilmPromptText | FilmPromptImage


@dataclass(frozen=True, slots=True)
class FilmFrame:
    node: str

    label: str

    kind: FrameKind
    url: str | None

    number: int | None

    prompt: tuple[FilmPromptRun, ...] | None

    aspect_ratio: str | None

    missing: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class FilmSetting:
    kind: SettingKind
    target: str | None

    label: str | None

    text: str
    images: tuple[str, ...]

    shared: bool


@dataclass(frozen=True, slots=True)
class FilmLine:
    target: str

    role: str

    text: str


@dataclass(frozen=True, slots=True)
class FilmShot:
    target: str | None

    start: float
    end: float
    parts: tuple[str, ...]

    lines: tuple[FilmLine, ...]
    view: str | None


@dataclass(frozen=True, slots=True)
class FilmGroup:
    index: int

    video: str

    model: str
    seconds: int
    aspect_ratio: str
    frames: tuple[FilmFrame, ...]
    settings: tuple[FilmSetting, ...]
    shots: tuple[FilmShot, ...]
    prompt: str


@dataclass(frozen=True, slots=True)
class FilmView:
    film_version: int
    run_version: int | None

    problems: int

    groups: tuple[FilmGroup, ...]

    music_description: str | None = None


@dataclass(frozen=True, slots=True)
class FilmImagePrompt:
    text: str
    reference_image_urls: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class FilmLineEdit:
    target: str
    text: str


@dataclass(frozen=True, slots=True)
class FilmTextEdit:
    target: str
    text: str | None = None
    parts: tuple[str, ...] | None = None
    lines: tuple[FilmLineEdit, ...] | None = None
    images: tuple[str, ...] = ()


__all__ = [
    "FilmFrame",
    "FilmGroup",
    "FilmImagePrompt",
    "FilmLine",
    "FilmLineEdit",
    "FilmPromptImage",
    "FilmPromptRun",
    "FilmPromptText",
    "FilmSetting",
    "FilmShot",
    "FilmTextEdit",
    "FilmView",
    "FrameKind",
    "SettingKind",
]
