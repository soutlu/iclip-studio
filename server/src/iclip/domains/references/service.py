"""参考视频用例：建行与排拆解、列表与筛选、修改、重拆、移除，以及给 AI 导演用的 ``ensure``。

端点权限由路由声明；这里管行级归属：谁都看得到，只有属主能改、能重拆、能移除。"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Final

import structlog

from iclip.common.errors import Conflict, NotFound, PermissionDenied, ValidationFailed
from iclip.domains.identity.public import Principal, visible_owner_incl_act_as
from iclip.domains.references.models import (
    BREAKDOWN_TIMEOUT_SECONDS,
    ERROR_TIMEOUT,
    STATUS_FAILED,
    STATUS_PENDING,
    STATUS_RUNNING,
    VIDEO_TYPES,
    CategoryValue,
    Outcome,
    ReferenceCursor,
    ReferenceVideo,
    Scope,
    Tags,
    VideoTypeValue,
)
from iclip.domains.references.repository import BreakdownQueue, OwnVideoUpload, ReferenceStore
from iclip.domains.references.schemas import (
    CategoryCountOut,
    OwnerCountOut,
    ReferenceFiltersOut,
    ReferenceUpdateIn,
    ReferenceVideoItemOut,
    ReferenceVideoOut,
    ReferenceVideosOut,
    VideoTypeCountOut,
)
from iclip.platform.paging import check_limit, decode_cursor, encode_cursor

_logger = structlog.stdlib.get_logger(__name__)

UPLOAD_PERMISSION: Final = "uploads:write"

ENSURE_POLL_SECONDS: Final = 3.0
"""导演等一条拆解时隔多久查一次这一行。"""

_BUSY: Final = frozenset({STATUS_PENDING, STATUS_RUNNING})


def _as_utc(moment: datetime | None) -> datetime | None:
    """无时区输入按 UTC 解释，避免与 timestamptz 比较时驱动报错。"""

    if moment is None or moment.tzinfo is not None:
        return moment
    return moment.replace(tzinfo=UTC)


def _unique[T](values: Sequence[T]) -> tuple[T, ...]:
    """去掉重复的，保留第一次出现的先后。"""

    return tuple(dict.fromkeys(values))


def _can_edit(principal: Principal, row: ReferenceVideo) -> bool:
    """看得到不等于改得动：只有属主，或读得到任何人记录的治理者与替人办事的钥匙。"""

    return visible_owner_incl_act_as(principal) in (None, row.owner_user_id)


def _require_owner(principal: Principal, row: ReferenceVideo) -> None:
    """别人的参考视频明确拒绝，不当作不存在。"""

    if not _can_edit(principal, row):
        raise PermissionDenied("只有它的属主能改这条参考视频")


def _item_fields(principal: Principal, row: ReferenceVideo) -> dict[str, object]:
    return {
        "id": row.id,
        "video_url": row.video_url,
        "user_name": row.owner_user_name,
        "video_types": list(row.video_types),
        "categories": list(row.categories),
        "breakdown_status": row.breakdown_status,
        "error_code": row.error_code,
        "version": row.version,
        "can_edit": _can_edit(principal, row),
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }


def _detail(principal: Principal, row: ReferenceVideo) -> ReferenceVideoOut:
    return ReferenceVideoOut.model_validate(
        {**_item_fields(principal, row), "document": row.document}
    )


def _item(principal: Principal, row: ReferenceVideo) -> ReferenceVideoItemOut:
    return ReferenceVideoItemOut.model_validate(_item_fields(principal, row))


class ReferenceService:
    """``queue`` 为 ``None`` 即拆解没配置：读照常，建行、重拆与 ``ensure`` 不可用。``uploads_available``
    为假即上传没装配（没有对象存储）：建行不可用，重拆与 ``ensure`` 照常。"""

    def __init__(
        self,
        store: ReferenceStore,
        *,
        own_video_upload: OwnVideoUpload,
        queue: BreakdownQueue | None,
        uploads_available: bool,
        poll_seconds: float = ENSURE_POLL_SECONDS,
        wait_seconds: float = BREAKDOWN_TIMEOUT_SECONDS,
    ) -> None:
        self._store = store
        self._own_video_upload = own_video_upload
        self._queue = queue
        self._uploads_available = uploads_available
        self._poll_seconds = poll_seconds
        self._wait_seconds = wait_seconds

    @property
    def accepts_uploads(self) -> bool:
        """能不能把视频上传放进资料库：拆解已配置，且上传可用。"""

        return self._queue is not None and self._uploads_available

    def can_upload(self, principal: Principal) -> bool:
        """资料库收上传，且读者持 ``uploads:write``。"""

        return self.accepts_uploads and principal.has(UPLOAD_PERMISSION)

    async def create(
        self, principal: Principal, upload_id: uuid.UUID
    ) -> tuple[ReferenceVideoOut, bool]:
        """把调用者自己的一条视频上传放进资料库；第二项是这次是不是新建的。

        同一个文件在上传时已经合成一个地址，所以按地址找行就够了：新建的排上第一次拆解；已有的直接
        交回，不再付费，移除过的回到资料库。别人的上传、不是视频的上传、不存在的都是 ``NotFound``。"""

        if not self.accepts_uploads:
            raise RuntimeError("资料库不收上传，建行的入口不该挂上")
        queue = self._require_queue()
        video_url = await self._own_video_upload(principal, upload_id)
        if video_url is None:
            raise NotFound("没有这条视频上传")
        row, created = await self._store.ensure_row(
            video_url,
            owner=principal.user_id,
            requested_by=principal.user_id,
            api_key_id=principal.api_key_id,
        )
        if created:
            await self._enqueue(queue, row.id)
        elif row.deleted_at is not None:
            await self._store.restore(row.id)
            row = await self._get(row.id)
        return _detail(principal, row), created

    async def list(
        self,
        principal: Principal,
        *,
        video_types: Sequence[VideoTypeValue] = (),
        categories: Sequence[CategoryValue] = (),
        user_name: str | None = None,
        q: str | None = None,
        since: datetime | None = None,
        until: datetime | None = None,
        limit: int = 20,
        cursor: str | None = None,
    ) -> ReferenceVideosOut:
        """建立晚的排前面；满页才给下一页游标，总数只在第一页给。"""

        check_limit(limit)
        since, until = _as_utc(since), _as_utc(until)
        if since is not None and until is not None and since >= until:
            raise ValidationFailed("since 必须早于 until")
        keyword = q.strip() if q is not None else ""
        scope = Scope(
            video_types=_unique(video_types),
            categories=_unique(categories),
            user_name=user_name,
            q=keyword or None,
            since=since,
            until=until,
        )
        after = None
        if cursor is not None:
            parsed = decode_cursor(cursor)
            after = ReferenceCursor(at=parsed.at, reference_id=parsed.uuid_key())
        rows = await self._store.list(scope, limit=limit, after=after)
        next_cursor = None
        if len(rows) == limit:
            next_cursor = encode_cursor(rows[-1].created_at, rows[-1].id)
        return ReferenceVideosOut(
            items=[_item(principal, row) for row in rows],
            next_cursor=next_cursor,
            total=await self._store.count(scope) if after is None else None,
            can_upload=self.can_upload(principal),
        )

    async def filters(self) -> ReferenceFiltersOut:
        """全部片子类型、用到的品类与名下有参考视频的属主，各带条数；只数没移除的。"""

        type_counts, category_counts = await self._store.filter_counts()
        owner_counts = await self._store.owner_counts()
        return ReferenceFiltersOut(
            video_types=[
                VideoTypeCountOut(
                    value=one.value, label=one.label, rule=one.rule, count=type_counts[one.value]
                )
                for one in VIDEO_TYPES
            ],
            categories=[
                CategoryCountOut(name=name, count=count) for name, count in category_counts
            ],
            owners=[OwnerCountOut(user_name=name, count=count) for name, count in owner_counts],
        )

    async def get(self, principal: Principal, reference_id: uuid.UUID) -> ReferenceVideoOut:
        return _detail(principal, await self._listed(reference_id))

    async def update(
        self, principal: Principal, reference_id: uuid.UUID, body: ReferenceUpdateIn
    ) -> ReferenceVideoOut:
        """属主改拆解正文与两组标签。版本对不上、正在拆解都是 ``Conflict``。"""

        row = await self._listed(reference_id)
        _require_owner(principal, row)
        if row.breakdown_status in _BUSY:
            raise Conflict("这条参考视频正在拆解，拆完再改")
        written = await self._store.update(
            reference_id,
            version=body.version,
            document=body.document,
            tags=Tags(video_types=_unique(body.video_types), categories=_unique(body.categories)),
        )
        if written is None:
            raise Conflict("这条参考视频已经变了（别处改过、刚拆完或正在拆），刷新后再改")
        return _detail(principal, await self._get(reference_id))

    async def rerun(self, principal: Principal, reference_id: uuid.UUID) -> ReferenceVideoOut:
        """属主重新拆解：已完成或已失败的行重新排队，拆成就覆盖拆解与标签。正在拆是 ``Conflict``。"""

        queue = self._require_queue()
        row = await self._listed(reference_id)
        _require_owner(principal, row)
        requeued = await self._store.requeue(
            reference_id,
            from_failed_only=False,
            requested_by=principal.user_id,
            api_key_id=principal.api_key_id,
        )
        if not requeued:
            raise Conflict("这条参考视频正在拆解，拆完再重拆")
        await self._enqueue(queue, reference_id)
        return _detail(principal, await self._get(reference_id))

    async def remove(self, principal: Principal, reference_id: uuid.UUID) -> None:
        """属主把它从资料库移除：只记移除时刻，按地址仍能读到它的拆解。"""

        row = await self._listed(reference_id)
        _require_owner(principal, row)
        if not await self._store.remove(reference_id):
            raise NotFound("资料库里没有这条参考视频")

    async def ensure(self, principal: Principal, video_url: str) -> Outcome:
        """AI 导演的入口：同一条视频只拆一次，别人在拆就等那一次。

        有拆解就直接用，哪怕有人正在重拆；没有就建行并排队，已失败的重新排队（导演每调一次工具就是
        一次尝试，还拆不拆由工具的重试次数管）；然后每 ``poll_seconds`` 查一次，最多等
        ``wait_seconds``，交回文档或失败原因。不查上传记录：这条视频是对话素材，不一定是本人的上传；
        属主记第一次拆它的人。移除过的照样用。"""

        queue = self._require_queue()
        row, created = await self._store.ensure_row(
            video_url,
            owner=principal.user_id,
            requested_by=principal.user_id,
            api_key_id=principal.api_key_id,
        )
        if row.document is not None:
            return Outcome(document=row.document)
        if created:
            await self._enqueue(queue, row.id)
        elif row.breakdown_status == STATUS_FAILED:
            # 条件更新：并发的几次只有一次改得动，只有它排队。
            requeued = await self._store.requeue(
                row.id,
                from_failed_only=True,
                requested_by=principal.user_id,
                api_key_id=principal.api_key_id,
            )
            if requeued:
                await self._enqueue(queue, row.id)
        return await self._wait(row.id)

    async def _wait(self, reference_id: uuid.UUID) -> Outcome:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self._wait_seconds
        while True:
            row = await self._get(reference_id)
            if row.document is not None:
                return Outcome(document=row.document)
            if row.breakdown_status == STATUS_FAILED:
                return Outcome(document=None, error_code=row.error_code)
            if loop.time() >= deadline:
                _logger.warning("等参考视频拆解超时", reference_id=reference_id)
                return Outcome(document=None, error_code=ERROR_TIMEOUT)
            await asyncio.sleep(self._poll_seconds)

    async def _enqueue(self, queue: BreakdownQueue, reference_id: uuid.UUID) -> None:
        """排一次拆解。排不上就把这一行收成 ``failed / model_call_failed``，免得它一直停在排队中、
        谁也重拆不了；再把错误抛给调用方。"""

        try:
            await queue.enqueue_breakdown(reference_id)
        except Exception:
            _logger.exception("参考视频拆解没排上队", reference_id=reference_id)
            await self._store.abandon_pending(reference_id)
            raise

    def _require_queue(self) -> BreakdownQueue:
        if self._queue is None:
            raise RuntimeError("拆解没配置，参考视频的写入口不该挂上")
        return self._queue

    async def _get(self, reference_id: uuid.UUID) -> ReferenceVideo:
        row = await self._store.get(reference_id)
        if row is None:
            raise RuntimeError(f"参考视频 {reference_id} 刚才还在，现在读不到了")
        return row

    async def _listed(self, reference_id: uuid.UUID) -> ReferenceVideo:
        """资料库里的这一行；不存在或已移除都是 ``NotFound``。"""

        row = await self._store.get(reference_id)
        if row is None or row.deleted_at is not None:
            raise NotFound("资料库里没有这条参考视频")
        return row


__all__ = ["ENSURE_POLL_SECONDS", "UPLOAD_PERMISSION", "ReferenceService"]
