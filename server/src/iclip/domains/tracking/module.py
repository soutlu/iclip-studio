from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from iclip.domains.tracking.api import create_tracking_router
from iclip.domains.tracking.repository import TrackingRepository
from iclip.domains.tracking.service import TrackingService


@dataclass(frozen=True)
class TrackingModule:
    routers: tuple[Any, ...]

    service: TrackingService


def build_tracking_module(repository: TrackingRepository) -> TrackingModule:
    service = TrackingService(repository)
    return TrackingModule(routers=(create_tracking_router(service),), service=service)


__all__ = ["TrackingModule", "build_tracking_module"]
