from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Protocol

from iclip.domains.generation.models import Inheritance
from iclip.domains.identity.public import Principal
from iclip.platform.media.fonts import FontInfo
from iclip.platform.media.probe import VideoProfile


class ConversationLineage(Protocol):
    async def ancestry(self, conversation_id: uuid.UUID) -> Inheritance: ...

    async def readable(self, principal: Principal, conversation_id: uuid.UUID) -> bool: ...


class RemoteMediaProbe(Protocol):
    async def duration_ms(self, url: str) -> int: ...

    async def video_profile(self, url: str) -> VideoProfile: ...


@dataclass(frozen=True, slots=True)
class BrandTemplateFacts:
    id: uuid.UUID
    kind: str
    name: str
    enabled: bool
    url: str
    duration_ms: int | None
    width: int | None
    height: int | None
    has_audio: bool | None
    font_info: FontInfo | None = None


BrandTemplates = Callable[[uuid.UUID], Awaitable[BrandTemplateFacts | None]]


__all__ = ["BrandTemplateFacts", "BrandTemplates", "ConversationLineage", "RemoteMediaProbe"]
