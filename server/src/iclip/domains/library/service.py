from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable, Mapping, Sequence
from datetime import UTC, datetime
from typing import Final

from iclip.common.errors import NotFound, ValidationFailed
from iclip.domains.identity.public import MANAGE_PERMISSION, Principal, visible_owner_incl_act_as
from iclip.domains.library.models import (
    HitCaseIneligible,
    MaterialSource,
    Orientation,
    Scope,
    VideoCursor,
    WholeFilmScope,
)
from iclip.domains.library.repository import CardRow, LibraryReports, WholeFilmCardRow
from iclip.domains.library.schemas import (
    HitCasesOut,
    HitCaseStateOut,
    LibraryAuthorsOut,
    LibraryVideoDetailOut,
    LibraryVideoOut,
    LibraryVideosOut,
    WholeFilmCardOut,
    WholeFilmCardsOut,
)
from iclip.domains.tagging.public import KIND_HIT_CASE, EntryKey, TaggingService
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


HasTreatment = Callable[[uuid.UUID, uuid.UUID], Awaitable[bool]]
"""（对话属主，对话 id）那段对话的工作区里有没有新片执行方案。"""

_INELIGIBLE: Final[Mapping[HitCaseIneligible, str]] = {
    "not_material": "这条视频不是成片素材里的素材片，无法加入爆款素材库",
    "no_conversation": "这条素材片不在任何对话里，没有新片执行方案，无法加入爆款素材库",
    "no_treatment": "所在对话没有新片执行方案，无法加入爆款素材库",
}


def _unique[T](values: Sequence[T]) -> tuple[T, ...]:
    """去掉重复的，保留第一次出现的先后。"""

    return tuple(dict.fromkeys(values))


def _hit_case_key(job_id: uuid.UUID) -> EntryKey:
    return EntryKey(kind=KIND_HIT_CASE, subject_id=job_id)


class HitCaseService:
    """爆款素材库：挑素材片入选、移出、改标签、重新打标与列表。谁持 ``generation:read`` 谁就能改。

    条目与标签都在标签域；能否入选看素材片口径与所在对话有没有新片执行方案（组合根注入）。
    ``tagging`` 没配打标时照样入选、改标签，只是不排打标。"""

    def __init__(
        self, reports: LibraryReports, *, tagging: TaggingService, has_treatment: HasTreatment
    ) -> None:
        self._reports = reports
        self._tagging = tagging
        self._has_treatment = has_treatment

    @property
    def can_retag(self) -> bool:
        """打标已配置：才挂重新打标。"""

        return self._tagging.can_tag

    async def list(
        self, *, tags: Sequence[uuid.UUID] = (), limit: int = 20, cursor: str | None = None
    ) -> HitCasesOut:
        """入选晚的排前面；满页才给下一页游标，总数只在第一页给。``tags`` 按维度分组：维度之间都要
        命中，同一维度命中任一，选了上级也算下级；不存在的标签是 ``ValidationFailed``。"""

        check_limit(limit)
        groups = await self._tagging.filter_groups(_unique(tags))
        after = _after(cursor)
        rows = await self._reports.hit_cases(groups, limit=limit, after=after)
        next_cursor = None
        if len(rows) == limit:
            last = rows[-1]
            next_cursor = encode_cursor(last.added_at, last.job_id)
        total = await self._reports.count_hit_cases(groups) if after is None else None
        return HitCasesOut(items=list(rows), next_cursor=next_cursor, total=total)

    async def state(self, job_id: uuid.UUID) -> HitCaseStateOut:
        """这条能不能入选、入选了没有；没有这条生成记录是 ``NotFound``。"""

        reason = await self._ineligible(await self._source(job_id))
        return await self._state(job_id, reason)

    async def add(
        self, principal: Principal, job_id: uuid.UUID, tag_ids: Sequence[uuid.UUID]
    ) -> HitCaseStateOut:
        """入选：不能入选是 ``ValidationFailed``（按原因说）；已入选原样交回，不改标签、不重打。
        否则建条目、写带来的标签、记入选人，打标配了就排一次打标。"""

        reason = await self._ineligible(await self._source(job_id))
        if reason is not None:
            raise ValidationFailed(_INELIGIBLE[reason])
        if await self._reports.hit_case_entry(job_id) is None:
            key = _hit_case_key(job_id)
            await self._tagging.replace(key, _unique(tag_ids), created_by=principal.user_id)
            if self._tagging.can_tag:
                await self._tagging.enqueue(key, created_by=principal.user_id)
        return await self._state(job_id, reason)

    async def replace_tags(
        self, principal: Principal, job_id: uuid.UUID, tag_ids: Sequence[uuid.UUID]
    ) -> HitCaseStateOut:
        """整份替换各维度的标签。没入选是 ``NotFound``；正在打标是 ``Conflict``；不存在的标签、维度
        本身是 ``ValidationFailed``。"""

        source = await self._entered(job_id)
        await self._tagging.replace(
            _hit_case_key(job_id), _unique(tag_ids), created_by=principal.user_id
        )
        return await self._state(job_id, await self._ineligible(source))

    async def retag(self, principal: Principal, job_id: uuid.UUID) -> HitCaseStateOut:
        """按所在对话当前的新片执行方案重新打标。没入选是 ``NotFound``；正在打标是 ``Conflict``。"""

        if not self._tagging.can_tag:
            raise RuntimeError("打标没配置，重新打标的入口不该挂上")
        source = await self._entered(job_id)
        await self._tagging.retag(_hit_case_key(job_id), created_by=principal.user_id)
        return await self._state(job_id, await self._ineligible(source))

    async def remove(self, job_id: uuid.UUID) -> None:
        """移出：删掉条目，标签随之删掉；没入选也照常返回。"""

        await self._tagging.remove(_hit_case_key(job_id))

    async def _source(self, job_id: uuid.UUID) -> MaterialSource:
        source = await self._reports.material_of(job_id)
        if source is None:
            raise NotFound("没有这条视频")
        return source

    async def _entered(self, job_id: uuid.UUID) -> MaterialSource:
        """入选了的这一条；没有这条视频或没入选都是 ``NotFound``。"""

        source = await self._source(job_id)
        if await self._reports.hit_case_entry(job_id) is None:
            raise NotFound("这条素材片不在爆款素材库里")
        return source

    async def _ineligible(self, source: MaterialSource) -> HitCaseIneligible | None:
        if not source.is_material:
            return "not_material"
        if source.conversation_id is None or source.conversation_owner is None:
            return "no_conversation"
        if not await self._has_treatment(source.conversation_owner, source.conversation_id):
            return "no_treatment"
        return None

    async def _state(self, job_id: uuid.UUID, reason: HitCaseIneligible | None) -> HitCaseStateOut:
        return HitCaseStateOut(
            job_id=job_id,
            eligible=reason is None,
            ineligible_reason=reason,
            entry=await self._reports.hit_case_entry(job_id),
        )


__all__ = ["HasProductionFiles", "HasTreatment", "HitCaseService", "LibraryService"]
