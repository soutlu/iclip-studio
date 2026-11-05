from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Literal

SortKey = Literal["impressions", "views", "clicks", "orders", "revenue"]

MatchLevel = Literal["exact", "sameBrandCategory", "sameCategory", "none"]


@dataclass(frozen=True, slots=True)
class MetricFilters:
    min_impressions: int | None = None
    min_views: int | None = None
    min_clicks: int | None = None
    min_orders: int | None = None
    min_revenue: Decimal | None = None


@dataclass(frozen=True, slots=True)
class StyleMatch:
    style_no: str
    match_level: MatchLevel


@dataclass(frozen=True, slots=True)
class VideoSearchResult:
    oss_urls: tuple[str, ...]
    matches: tuple[StyleMatch, ...]


__all__ = [
    "MatchLevel",
    "MetricFilters",
    "SortKey",
    "StyleMatch",
    "VideoSearchResult",
]
