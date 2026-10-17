from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol

from iclip.domains.library.models import Scope, VideoCursor
from iclip.domains.library.schemas import (
    LibraryAuthorOut,
    LibraryVideoOut,
    ShotGroupOut,
)


@dataclass(frozen=True, slots=True)
class CardRow:
    video: LibraryVideoOut
    conversation_owner: uuid.UUID | None
    conversation_deleted: bool


class LibraryReports(Protocol):
    async def videos(
        self, scope: Scope, *, limit: int, after: VideoCursor | None
    ) -> Sequence[CardRow]: ...

    async def count(self, scope: Scope) -> int: ...

    async def card_of(self, card_id: uuid.UUID) -> CardRow | None: ...

    async def groups_of(self, card_id: uuid.UUID) -> Sequence[ShotGroupOut]: ...

    async def authors(self) -> Sequence[LibraryAuthorOut]: ...


__all__ = ["CardRow", "LibraryReports"]
