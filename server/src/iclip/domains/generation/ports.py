from __future__ import annotations

import uuid
from typing import Protocol

from iclip.domains.generation.models import Inheritance
from iclip.domains.identity.public import Principal


class ConversationLineage(Protocol):
    async def ancestry(self, conversation_id: uuid.UUID) -> Inheritance: ...

    async def readable(self, principal: Principal, conversation_id: uuid.UUID) -> bool: ...


class RemoteMediaProbe(Protocol):
    async def duration_ms(self, url: str) -> int: ...


__all__ = ["ConversationLineage", "RemoteMediaProbe"]
