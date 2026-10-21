from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime

from iclip.common.errors import NotFound, ValidationFailed
from iclip.domains.identity.public import MANAGE_PERMISSION, Principal, visible_owner_incl_act_as
from iclip.domains.library.models import Orientation, Scope, VideoCursor, WholeFilmScope
from iclip.domains.library.repository import CardRow, LibraryReports, WholeFilmCardRow
from iclip.domains.library.schemas import (
    LibraryAuthorsOut,
    LibraryVideoDetailOut,
    LibraryVideoOut,
    LibraryVideosOut,
    WholeFilmCardOut,
    WholeFilmCardsOut,
)
from iclip.platform.paging import check_limit, decode_cursor, encode_cursor


def _as_utc(moment: datetime | None) -> datetime | None:
    if moment is None or moment.tzinfo is not None:
        return moment
    return moment.replace(tzinfo=UTC)


def _window(
    since: datetime | None, until: datetime | None
) -> tuple[datetime | None, datetime | None]:
    since, until = _as_utc(since), _as_utc(until)
    if since is not None and until is not None and since >= until:
        raise ValidationFailed("since 必须早于 until")
    return since, until


def _keyword(q: str | None) -> str | None:
    keyword = q.strip() if q is not None else ""
    return keyword or None


def _scope(
    *,
    user_name: str | None,
    since: datetime | None,
    until: datetime | None,
    orientation: Orientation | None,
    q: str | None,
) -> Scope:
    since, until = _window(since, until)
    return Scope(
        user_name=user_name,
        since=since,
        until=until,
        orientation=orientation,
        q=_keyword(q),
    )


def _after(cursor: str | None) -> VideoCursor | None:
    if cursor is None:
        return None
    parsed = decode_cursor(cursor)
    return VideoCursor(at=parsed.at, video_id=parsed.uuid_key())


def _can_open(
    principal: Principal, conversation_owner: uuid.UUID | None, conversation_deleted: bool
) -> bool:
    if conversation_owner is None:
        return False
    if principal.has(MANAGE_PERMISSION):
        return True
    owner = visible_owner_incl_act_as(principal)
    return not conversation_deleted and (owner is None or owner == conversation_owner)


def _for_reader(principal: Principal, row: CardRow) -> LibraryVideoOut:
    can_open = _can_open(principal, row.conversation_owner, row.conversation_deleted)
    return row.video.model_copy(update={"can_open_conversation": can_open})


def _film_for_reader(principal: Principal, row: WholeFilmCardRow) -> WholeFilmCardOut:
    can_open = _can_open(principal, row.conversation_owner, row.conversation_deleted)
    return row.card.model_copy(update={"can_open_conversation": can_open})


HasProductionFiles = Callable[[uuid.UUID, uuid.UUID], Awaitable[bool]]


class LibraryService:
    def __init__(
        self, reports: LibraryReports, *, has_production_files: HasProductionFiles
    ) -> None:
        self._reports = reports
        self._has_production_files = has_production_files

    async def videos(
        self,
        principal: Principal,
        *,
        user_name: str | None = None,
        since: datetime | None = None,
        until: datetime | None = None,
        orientation: Orientation | None = None,
        q: str | None = None,
        limit: int = 20,
        cursor: str | None = None,
    ) -> LibraryVideosOut:
        check_limit(limit)
        scope = _scope(user_name=user_name, since=since, until=until, orientation=orientation, q=q)
        after = _after(cursor)
        rows = await self._reports.videos(scope, limit=limit, after=after)
        next_cursor = None
        if len(rows) == limit:
            last = rows[-1].video
            next_cursor = encode_cursor(last.face.finished_at, last.id)
        total = await self._reports.count(scope) if after is None else None
        return LibraryVideosOut(
            items=[_for_reader(principal, row) for row in rows],
            next_cursor=next_cursor,
            total=total,
        )

    async def video(self, principal: Principal, card_id: uuid.UUID) -> LibraryVideoDetailOut:
        row = await self._reports.card_of(card_id)
        if row is None:
            raise NotFound("资料库里没有这条视频")
        groups = await self._reports.groups_of(card_id)
        video = _for_reader(principal, row)
        return LibraryVideoDetailOut(
            video=video,
            groups=list(groups),
            can_make_same=await self._can_make_same(row),
        )

    async def _can_make_same(self, row: CardRow) -> bool:
        conversation_id = row.video.conversation_id
        if conversation_id is None or row.conversation_owner is None:
            return False
        return await self._has_production_files(row.conversation_owner, conversation_id)

    async def authors(self) -> LibraryAuthorsOut:
        return LibraryAuthorsOut(items=list(await self._reports.authors()))

    async def whole_film_authors(self) -> LibraryAuthorsOut:
        return LibraryAuthorsOut(items=list(await self._reports.whole_film_authors()))

    async def whole_films(
        self,
        principal: Principal,
        *,
        user_name: str | None = None,
        since: datetime | None = None,
        until: datetime | None = None,
        q: str | None = None,
        limit: int = 20,
        cursor: str | None = None,
    ) -> WholeFilmCardsOut:
        check_limit(limit)
        since, until = _window(since, until)
        scope = WholeFilmScope(user_name=user_name, since=since, until=until, q=_keyword(q))
        after = _after(cursor)
        rows = await self._reports.whole_films(scope, limit=limit, after=after)
        next_cursor = None
        if len(rows) == limit:
            last = rows[-1].card
            next_cursor = encode_cursor(last.face.finished_at, last.conversation_id)
        total = await self._reports.count_whole_films(scope) if after is None else None
        return WholeFilmCardsOut(
            items=[_film_for_reader(principal, row) for row in rows],
            next_cursor=next_cursor,
            total=total,
        )


__all__ = ["HasProductionFiles", "LibraryService"]
