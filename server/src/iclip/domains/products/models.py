from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class StyleGrouping:
    category_id: int
    brand_code: str


__all__ = ["StyleGrouping"]
