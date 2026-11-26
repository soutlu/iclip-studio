from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol

from iclip.domains.generation.models import Inheritance
from iclip.domains.identity.public import Principal


class ConversationLineage(Protocol):
    async def ancestry(self, conversation_id: uuid.UUID) -> Inheritance: ...

    async def readable(self, principal: Principal, conversation_id: uuid.UUID) -> bool: ...


class RemoteMediaProbe(Protocol):
    async def duration_ms(self, url: str) -> int: ...


@dataclass(frozen=True, slots=True)
class VoiceSample:
    """参考音频库里一条音色的地址与台词。"""

    url: str
    transcript: str | None


class ReferenceAssets(Protocol):
    """生成要用的参考资产与上传，由组合根接到参考资产库与上传台账上。"""

    async def unlisted(self, reference_ids: Sequence[uuid.UUID]) -> tuple[uuid.UUID, ...]:
        """``reference_ids`` 里不在资料库、或已经移除的那些，按原顺序。"""
        ...

    async def voice(self, reference_id: uuid.UUID) -> VoiceSample | None:
        """一条没移除的音色；不存在、移除了或不是音色时为 None。"""
        ...

    async def own_audio_upload(self, principal: Principal, upload_id: uuid.UUID) -> str | None:
        """调用者本人这条音频上传的地址；不是本人的、不是音频或没有这条时为 None。"""
        ...


__all__ = [
    "ConversationLineage",
    "ReferenceAssets",
    "RemoteMediaProbe",
    "VoiceSample",
]
