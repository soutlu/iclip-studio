from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol

from iclip.domains.library.models import Scope, VideoCursor, WholeFilmScope
from iclip.domains.library.schemas import (
    LibraryAuthorOut,
    LibraryVideoOut,
    ShotGroupOut,
    WholeFilmCardOut,
)


@dataclass(frozen=True, slots=True)
class CardRow:
    video: LibraryVideoOut
    conversation_owner: uuid.UUID | None
    conversation_deleted: bool


@dataclass(frozen=True, slots=True)
class WholeFilmCardRow:
    card: WholeFilmCardOut
    conversation_owner: uuid.UUID
    conversation_deleted: bool


class LibraryReports(Protocol):
    async def videos(
        self, scope: Scope, *, limit: int, after: VideoCursor | None
    ) -> Sequence[CardRow]: ...

    async def count(self, scope: Scope) -> int: ...

    async def card_of(self, card_id: uuid.UUID) -> CardRow | None: ...

    async def groups_of(self, card_id: uuid.UUID) -> Sequence[ShotGroupOut]: ...

    async def authors(self) -> Sequence[LibraryAuthorOut]: ...

    async def whole_films(
        self, scope: WholeFilmScope, *, limit: int, after: VideoCursor | None
    ) -> Sequence[WholeFilmCardRow]: ...

    async def count_whole_films(self, scope: WholeFilmScope) -> int: ...

    async def whole_film_authors(self) -> Sequence[LibraryAuthorOut]: ...


__all__ = ["CardRow", "LibraryReports", "WholeFilmCardRow"]
