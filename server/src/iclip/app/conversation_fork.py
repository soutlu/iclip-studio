from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable
from datetime import datetime

from iclip.domains.conversations.infra_sql import SqlConversationRepository
from iclip.domains.identity.public import Principal

ConversationReadable = Callable[[Principal, uuid.UUID], Awaitable[bool]]


class ForkLineageAdapter:
    def __init__(
        self, *, conversations: SqlConversationRepository, readable: ConversationReadable
    ) -> None:
        self._conversations = conversations
        self._readable = readable

    async def ancestry(self, conversation_id: uuid.UUID) -> tuple[tuple[uuid.UUID, datetime], ...]:
        return await self._conversations.ancestry(conversation_id)

    async def readable(self, principal: Principal, conversation_id: uuid.UUID) -> bool:
        return await self._readable(principal, conversation_id)


__all__ = ["ForkLineageAdapter"]
