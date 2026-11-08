from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True, slots=True)
class Collection:
    id: uuid.UUID
    owner_user_id: uuid.UUID
    name: str
    created_at: datetime
    updated_at: datetime


__all__ = ["Collection"]
