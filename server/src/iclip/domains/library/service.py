"""资料库用例：整理筛选范围与游标，并按读者算能不能打开来源对话。端点权限由路由声明。"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime

from iclip.common.errors import NotFound, ValidationFailed
from iclip.domains.identity.public import MANAGE_PERMISSION, Principal, visible_owner_incl_act_as
from iclip.domains.library.models import Orientation, Scope, VideoCursor
from iclip.domains.library.repository import CardRow, LibraryReports
from iclip.domains.library.schemas import (
    LibraryAuthorsOut,
    LibraryVideoDetailOut,
    LibraryVideoOut,
    LibraryVideosOut,
)
from iclip.platform.paging import check_limit, decode_cursor, encode_cursor


def _as_utc(moment: datetime | None) -> datetime | None:
    """无时区输入按 UTC 解释，避免与 timestamptz 比较时驱动报错。"""

    if moment is None or moment.tzinfo is not None:
        return moment
    return moment.replace(tzinfo=UTC)


def _scope(
    *,
    user_name: str | None,
    since: datetime | None,
    until: datetime | None,
    orientation: Orientation | None,
    q: str | None,
) -> Scope:
    since, until = _as_utc(since), _as_utc(until)
    if since is not None and until is not None and since >= until:
        raise ValidationFailed("since 必须早于 until")
    keyword = q.strip() if q is not None else ""
    return Scope(
        user_name=user_name,
        since=since,
        until=until,
        orientation=orientation,
        q=keyword or None,
    )


def _after(cursor: str | None) -> VideoCursor | None:
    if cursor is None:
        return None
    parsed = decode_cursor(cursor)
    return VideoCursor(at=parsed.at, video_id=parsed.uuid_key())


def _can_open(principal: Principal, row: CardRow) -> bool:
    """口径同对话的读路径：治理者读得到任何对话，含墓碑；其余人要对话没删，且是属主或持
    ``users:act_as`` 的钥匙。不挂对话的卡没有对话可开。"""

    if row.video.conversation_id is None:
        return False
    if principal.has(MANAGE_PERMISSION):
        return True
    owner = visible_owner_incl_act_as(principal)
    return not row.conversation_deleted and (owner is None or owner == row.conversation_owner)


def _for_reader(principal: Principal, row: CardRow) -> LibraryVideoOut:
    return row.video.model_copy(update={"can_open_conversation": _can_open(principal, row)})


HasProductionFiles = Callable[[uuid.UUID, uuid.UUID], Awaitable[bool]]
"""这段对话的工作区里有没有工程文件或分镜文件，参数为 (属主, 对话 id)；由组合根接到工作区上，
与建对话时做同款的拷贝同一个判断。"""


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
        """卡面完成时刻晚的排前面；满页才给下一页游标，总数只在第一页给。"""

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
        """一张卡的详情；``card_id`` 不是卡 id 就是 ``NotFound``。对话删了照常返回。

        做不做得了同款只在详情里算：要读这段对话的工作区，列表上逐张去读太贵。"""

        row = await self._reports.card_of(card_id)
        if row is None:
            raise NotFound("资料库里没有这条视频")
        groups = await self._reports.groups_of(card_id)
        video = _for_reader(principal, row)
        return LibraryVideoDetailOut(
            video=video,
            groups=list(groups),
            can_make_same=await self._can_make_same(video, row),
        )

    async def _can_make_same(self, video: LibraryVideoOut, row: CardRow) -> bool:
        """读者打得开这段对话、它的工作区里又有工程文件或分镜文件。"""

        if not video.can_open_conversation:
            return False
        if video.conversation_id is None or row.conversation_owner is None:
            return False
        return await self._has_production_files(row.conversation_owner, video.conversation_id)

    async def authors(self) -> LibraryAuthorsOut:
        return LibraryAuthorsOut(items=list(await self._reports.authors()))


__all__ = ["HasProductionFiles", "LibraryService"]
