from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from iclip.domains.inspirations.api import create_inspirations_router
from iclip.domains.inspirations.infra_sql import PgInspirationVideos
from iclip.domains.inspirations.service import InspirationService
from iclip.domains.products.public import StyleDirectory


@dataclass(frozen=True, slots=True)
class InspirationsModule:
    routers: tuple[Any, ...]


def build_inspirations_module(
    videos: PgInspirationVideos, styles: StyleDirectory
) -> InspirationsModule:
    service = InspirationService(videos, styles)
    return InspirationsModule(routers=(create_inspirations_router(service),))


__all__ = ["InspirationsModule", "build_inspirations_module"]
