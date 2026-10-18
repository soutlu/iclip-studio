from __future__ import annotations

import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Final, Literal

FontContentType = Literal["font/ttf", "font/otf"]

FONT_EXTENSIONS: Final[Mapping[FontContentType, str]] = {"font/ttf": "ttf", "font/otf": "otf"}


@dataclass(frozen=True, slots=True)
class BrandTemplate:
    id: uuid.UUID
    kind: str
    brand: str | None
    name: str
    url: str
    created_by: uuid.UUID
    created_at: datetime
    disabled_at: datetime | None


__all__ = [
    "FONT_EXTENSIONS",
    "BrandTemplate",
    "FontContentType",
]
