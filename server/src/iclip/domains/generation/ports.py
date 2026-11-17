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


class ReferenceClipCheck(Protocol):
    async def __call__(self, principal: Principal, url: str, /) -> bool:
        """局部编辑能不能拿这个地址作参考片段：调用者本人的一条视频上传，或资料库里一条没移除的
        参考视频。"""
        ...


__all__ = ["ConversationLineage", "ReferenceClipCheck", "RemoteMediaProbe"]
