from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol

from iclip.domains.library.models import (
    HitCaseScope,
    MaterialSource,
    Scope,
    VideoCursor,
    WholeFilmScope,
)
from iclip.domains.library.schemas import (
    HitCaseEntryOut,
    HitCaseOut,
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

    async def material_of(self, job_id: uuid.UUID) -> MaterialSource | None:
        """这条生成记录是不是素材片、所在对话与它的属主；没有这条记录给 ``None``。"""
        ...

    async def hit_case_entry(self, job_id: uuid.UUID) -> HitCaseEntryOut | None:
        """这条素材片在爆款素材库里的条目；没入选给 ``None``。"""
        ...

    async def hit_cases(
        self,
        scope: HitCaseScope,
        *,
        limit: int,
        after: VideoCursor | None,
    ) -> Sequence[HitCaseOut]:
        """爆款素材，入选晚的在前，只列仍是素材片的；游标是入选时刻加素材片 id。"""
        ...

    async def count_hit_cases(self, scope: HitCaseScope) -> int: ...

    async def hit_case_authors(self) -> Sequence[LibraryAuthorOut]: ...


__all__ = ["CardRow", "LibraryReports", "WholeFilmCardRow"]
