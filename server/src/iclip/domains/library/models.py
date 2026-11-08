from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

Orientation = Literal["portrait", "landscape"]


@dataclass(frozen=True, slots=True)
class Scope:
    user_name: str | None = None
    since: datetime | None = None
    until: datetime | None = None
    orientation: Orientation | None = None
    q: str | None = None


@dataclass(frozen=True, slots=True)
class WholeFilmScope:
    user_name: str | None = None
    since: datetime | None = None
    until: datetime | None = None
    q: str | None = None


@dataclass(frozen=True, slots=True)
class HitCaseScope:
    tag_groups: tuple[tuple[uuid.UUID, ...], ...] = ()
    user_name: str | None = None
    since: datetime | None = None
    until: datetime | None = None


@dataclass(frozen=True, slots=True)
class VideoCursor:
    at: datetime
    video_id: uuid.UUID


HitCaseIneligible = Literal["not_material", "no_conversation", "no_treatment"]


@dataclass(frozen=True, slots=True)
class MaterialSource:
    job_id: uuid.UUID
    is_material: bool
    conversation_id: uuid.UUID | None
    conversation_owner: uuid.UUID | None


__all__ = [
    "HitCaseIneligible",
    "HitCaseScope",
    "MaterialSource",
    "Orientation",
    "Scope",
    "VideoCursor",
    "WholeFilmScope",
]
