from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Final, Literal

EventName = Literal["video.downloaded"]

VIDEO_DOWNLOADED: Final = "video.downloaded"


@dataclass(frozen=True, slots=True)
class TrackingEvent:
    name: EventName
    job_id: uuid.UUID | None
    conversation_id: uuid.UUID | None
    user_id: uuid.UUID
    api_key_id: uuid.UUID | None


__all__ = ["VIDEO_DOWNLOADED", "EventName", "TrackingEvent"]
