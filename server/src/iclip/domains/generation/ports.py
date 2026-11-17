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


class ModelGroupOf(Protocol):
    """用户所在配置组的组名，默认组答 ``None``；由组合根接到身份域。"""

    async def __call__(self, user_id: uuid.UUID, /) -> str | None: ...


__all__ = ["ConversationLineage", "ModelGroupOf", "RemoteMediaProbe"]
