from __future__ import annotations

import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Final, Literal

MAX_TEMPLATE_MS: Final = 10_000

FontContentType = Literal["font/ttf", "font/otf"]

FONT_EXTENSIONS: Final[Mapping[FontContentType, str]] = {"font/ttf": "ttf", "font/otf": "otf"}


@dataclass(frozen=True, slots=True)
class ProbedVideo:
    width: int
    height: int
    duration_ms: int
    has_audio: bool


@dataclass(frozen=True, slots=True)
class BrandTemplate:
    id: uuid.UUID
    kind: str
    brand: str | None
    name: str
    url: str
    width: int | None
    height: int | None
    duration_ms: int | None
    has_audio: bool | None
    created_by: uuid.UUID
    created_at: datetime
    disabled_at: datetime | None


__all__ = [
    "FONT_EXTENSIONS",
    "MAX_TEMPLATE_MS",
    "BrandTemplate",
    "FontContentType",
    "ProbedVideo",
]
