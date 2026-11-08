from __future__ import annotations

import uuid
from typing import Protocol

from iclip.domains.tracking.models import TrackingEvent


class TrackingRepository(Protocol):
    async def downloadable(self, job_id: uuid.UUID) -> bool: ...

    async def record(self, event: TrackingEvent) -> None: ...


__all__ = ["TrackingRepository"]
