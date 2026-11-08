from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field

from iclip.domains.inspirations.infra_sql import PgInspirationVideos
from iclip.domains.inspirations.models import (
    MatchLevel,
    MetricFilters,
    SortKey,
    StyleMatch,
    VideoSearchResult,
)
from iclip.domains.products.public import StyleDirectory, StyleGrouping


@dataclass(frozen=True, slots=True)
class _FallbackResult:
    levels: Mapping[str, MatchLevel] = field(default_factory=dict)
    brand_categories: tuple[StyleGrouping, ...] = ()
    categories: tuple[int, ...] = ()


class NoStyleDirectory:
    async def resolve(self, style_nos: Sequence[str]) -> Mapping[str, StyleGrouping]:
        return {}


class InspirationService:
    def __init__(self, videos: PgInspirationVideos, styles: StyleDirectory) -> None:
        self._videos = videos
        self._styles = styles

    async def search_videos(
        self,
        style_nos: Sequence[str],
        *,
        filters: MetricFilters,
        sort_by: SortKey,
        limit: int,
    ) -> VideoSearchResult:
        wanted = _unique(style_nos)
        exact = await self._videos.styles_with_videos(wanted)
        unresolved = tuple(style_no for style_no in wanted if style_no not in exact)

        levels: dict[str, MatchLevel] = {style_no: "exact" for style_no in exact}
        fallback = await self._fall_back(unresolved)
        levels.update(fallback.levels)

        urls = await self._videos.find_urls(
            style_nos=sorted(exact),
            brand_categories=fallback.brand_categories,
            categories=fallback.categories,
            filters=filters,
            sort_by=sort_by,
            limit=limit,
        )
        return VideoSearchResult(
            oss_urls=urls,
            matches=tuple(
                StyleMatch(style_no=style_no, match_level=levels.get(style_no, "none"))
                for style_no in wanted
            ),
        )

    async def _fall_back(self, unresolved: Sequence[str]) -> _FallbackResult:
        if not unresolved:
            return _FallbackResult()

        groups = await self._styles.resolve(unresolved)
        category_ids = _unique(group.category_id for group in groups.values())
        pairs, with_videos = await self._videos.groups_with_videos(category_ids)

        levels: dict[str, MatchLevel] = {}
        brand_categories: list[StyleGrouping] = []
        categories: list[int] = []
        for style_no in unresolved:
            group = groups.get(style_no)
            if group is None:
                levels[style_no] = "none"
                continue
            if (group.category_id, group.brand_code) in pairs:
                levels[style_no] = "sameBrandCategory"
                brand_categories.append(group)
            elif group.category_id in with_videos:
                levels[style_no] = "sameCategory"
                categories.append(group.category_id)
            else:
                levels[style_no] = "none"
        return _FallbackResult(
            levels=levels,
            brand_categories=_unique(brand_categories),
            categories=_unique(categories),
        )


def _unique[ItemT](items: Iterable[ItemT]) -> tuple[ItemT, ...]:
    return tuple(dict.fromkeys(items))


__all__ = ["InspirationService", "NoStyleDirectory"]
