from __future__ import annotations

import re
import uuid
from collections.abc import Collection, Mapping
from datetime import UTC, datetime
from typing import Final, Protocol

import structlog

from iclip.common.errors import Conflict, NotFound, ValidationFailed
from iclip.domains.identity.public import Principal
from iclip.domains.uploads.models import (
    MAX_BYTES,
    MAX_LONG_EDGE_PIXELS,
    MIN_SHORT_EDGE_PIXELS,
    UPLOAD_TYPES,
    Inheritance,
    MediaKind,
    MediaUpload,
)
from iclip.domains.uploads.repository import UploadRepository
from iclip.domains.uploads.schemas import UploadSignIn
from iclip.platform.media.image import read_image_header
from iclip.platform.object_store.direct_upload import (
    UploadTicket,
    audit_metadata,
    signed_upload_ticket,
)
from iclip.platform.object_store.layout import MEDIA_PATHS
from iclip.platform.object_store.store import ObjectStoreUnavailable, PublicBucket, StoredObject
from iclip.platform.outbound.fetch import FetchTooLarge
from iclip.platform.outbound.guard import FetchFailed
from iclip.platform.paging import check_limit

_logger = structlog.stdlib.get_logger(__name__)

# 阿里云 OSS 仅对单次普通上传（PutObject）返回内容 MD5 作为 ETag。
_NORMAL_OBJECT: Final = "Normal"

_MD5_HEX: Final = re.compile(r"[0-9a-fA-F]{32}")


class ConversationWritable(Protocol):
    async def __call__(self, principal: Principal, conversation_id: uuid.UUID, /) -> object: ...


class FetchBytes(Protocol):
    async def __call__(self, url: str, *, max_bytes: int) -> bytes: ...


class UploadLineage(Protocol):
    async def ancestry(self, conversation_id: uuid.UUID) -> Inheritance: ...

    async def readable(self, principal: Principal, conversation_id: uuid.UUID) -> bool: ...


class UploadService:
    def __init__(
        self,
        objects: PublicBucket,
        repo: UploadRepository,
        *,
        fetch: FetchBytes,
        conversation_writable: ConversationWritable,
        lineage: UploadLineage,
    ) -> None:
        self._objects = objects
        self._repo = repo
        self._fetch = fetch
        self._conversation_writable = conversation_writable
        self._lineage = lineage

    def sign_upload(self, principal: Principal, body: UploadSignIn) -> UploadTicket:
        kind, ext, normalized = _accepted_type(body.content_type)
        if kind == "image":
            if body.width is None or body.height is None:
                raise ValidationFailed("上传图片须提供宽高信息")
            _check_dimensions(body.width, body.height)
        upload_id = uuid.uuid4()
        return signed_upload_ticket(
            self._objects,
            upload_id=upload_id,
            object_key=MEDIA_PATHS.upload(upload_id=upload_id, ext=ext),
            content_type=normalized,
            user_id=principal.user_id,
            api_key_id=principal.api_key_id,
        )

    async def confirm(
        self,
        principal: Principal,
        upload_id: uuid.UUID,
        *,
        conversation_id: uuid.UUID | None = None,
        width: int | None = None,
        height: int | None = None,
    ) -> MediaUpload:
        """核对桶里的对象后记进台账；记过的原样交回，不再改它。

        大小、内容类型与 MD5 取对象存储报的；图片的宽高取调用方报的（签名时报过的那两个数，
        越界 ``ValidationFailed``），别的种类不记宽高。时长不量。
        """

        recorded = await self._repo.get(upload_id)
        if recorded is not None:
            return recorded
        found = await self._objects.find_object(
            prefix=MEDIA_PATHS.upload_prefix(upload_id=upload_id)
        )
        if found is None:
            raise Conflict("文件尚未上传完成，请上传完成后再确认")
        kind = _checked_kind(found)
        if kind == "image" and width is not None and height is not None:
            _check_dimensions(width, height)
        else:
            width = height = None
        if conversation_id is not None:
            await self._conversation_writable(principal, conversation_id)
        content_md5 = _content_md5(kind, found)
        earlier = (
            None if content_md5 is None else await self._repo.earliest_video_with_md5(content_md5)
        )
        url = self._objects.public_url(found.object_key) if earlier is None else earlier.url
        stored = await self._repo.insert(
            MediaUpload(
                id=upload_id,
                owner_user_id=principal.user_id,
                api_key_id=principal.api_key_id,
                conversation_id=conversation_id,
                kind=kind,
                url=url,
                # 去重时地址是最早那份的，类型也按那份记（同一份内容，扩展名可能不同）
                content_type=(earlier.content_type if earlier is not None else None)
                or found.content_type,
                size_bytes=found.size_bytes,
                duration_ms=None,
                width=width,
                height=height,
                content_md5=content_md5,
                created_at=datetime.now(UTC),
            )
        )
        # 同一个 uploadId 并发确认时，后到的那次按 MD5 会找到先到那次刚记下的自己，那不是重复的另一份
        if earlier is not None and earlier.id != upload_id:
            await self._discard_duplicate(found.object_key, upload_id=upload_id)
        return stored

    async def import_image(self, principal: Principal, url: str, *, upload_id: uuid.UUID) -> str:
        recorded = await self._repo.get(upload_id)
        if recorded is not None:
            return recorded.url
        limit = MAX_BYTES["image"]
        try:
            content = await self._fetch(url, max_bytes=limit)
        except FetchTooLarge as exc:
            raise ValidationFailed(_too_large(limit)) from exc
        except FetchFailed as exc:
            raise ValidationFailed(f"图片下载失败：{exc}") from exc
        if len(content) > limit:
            raise ValidationFailed(_too_large(limit))
        header = read_image_header(content)
        if header is None:
            raise ValidationFailed("下载的文件不是有效的图片")
        known = UPLOAD_TYPES.get(header.mime or "")
        if header.mime is None or known is None or known[0] != "image":
            allowed = "、".join(
                sorted(mime for mime, (kind, _) in UPLOAD_TYPES.items() if kind == "image")
            )
            raise ValidationFailed(
                f"下载的图片格式不受支持（{header.mime or '未知类型'}），仅支持：{allowed}"
            )
        _check_dimensions(header.width, header.height)
        stored = await self._objects.put_public_object(
            object_key=MEDIA_PATHS.upload(upload_id=upload_id, ext=known[1]),
            content=content,
            content_type=header.mime,
            metadata=audit_metadata(user_id=principal.user_id, api_key_id=principal.api_key_id),
        )
        recorded = await self._repo.insert(
            MediaUpload(
                id=upload_id,
                owner_user_id=principal.user_id,
                api_key_id=principal.api_key_id,
                conversation_id=None,
                kind="image",
                url=stored,
                content_type=header.mime,
                size_bytes=len(content),
                duration_ms=None,
                width=header.width,
                height=header.height,
                content_md5=None,
                created_at=datetime.now(UTC),
            )
        )
        return recorded.url

    async def conversation_uploads(
        self,
        principal: Principal,
        conversation_id: uuid.UUID,
        *,
        limit: int,
        kind: MediaKind | None = None,
        before: uuid.UUID | None = None,
    ) -> tuple[MediaUpload, ...]:
        """挂在这段对话上的上传，含经分叉继承来的（祖先对话在分叉时刻以前挂上的），新的在前。

        读不到这段对话 ``NotFound``；``before`` 指的上传不存在也是 ``NotFound``。
        """

        check_limit(limit)
        if not await self._lineage.readable(principal, conversation_id):
            raise NotFound(f"对话不存在：{conversation_id}")
        anchor = None
        if before is not None:
            anchor = await self._repo.get(before)
            if anchor is None:
                raise NotFound(f"上传记录不存在：{before}")
        return await self._repo.list_in_conversation(
            conversation_id,
            limit=limit,
            kind=kind,
            before=anchor,
            inherited=await self._lineage.ancestry(conversation_id),
        )

    async def conversation_uploads_at(
        self, conversation_id: uuid.UUID, urls: Collection[str]
    ) -> Mapping[str, MediaUpload]:
        """这段对话（含分叉继承）里每个地址对上的最早那条上传；对不上的地址不在答复里。"""

        return await self._repo.earliest_in_conversation(
            conversation_id, urls, inherited=await self._lineage.ancestry(conversation_id)
        )

    async def own_upload(
        self, principal: Principal, upload_id: uuid.UUID, *, kind: MediaKind
    ) -> str | None:
        """调用者本人这条 ``kind`` 上传的地址；不是本人的、种类不对或没有这条时为 None。"""

        upload = await self._repo.get(upload_id)
        if upload is None or upload.kind != kind or upload.owner_user_id != principal.user_id:
            return None
        return upload.url

    async def _discard_duplicate(self, object_key: str, *, upload_id: uuid.UUID) -> None:
        try:
            await self._objects.delete_object(object_key)
        except ObjectStoreUnavailable as exc:
            _logger.warning(
                "重复上传的对象删除失败", upload_id=upload_id, object_key=object_key, error=str(exc)
            )


def _checked_kind(found: StoredObject) -> MediaKind:
    known = UPLOAD_TYPES.get(found.content_type)
    if known is None:
        raise ValidationFailed(f"已上传文件的类型 {found.content_type} 不在允许范围内")
    kind: MediaKind = known[0]
    if found.size_bytes > MAX_BYTES[kind]:
        raise ValidationFailed(_too_large(MAX_BYTES[kind]))
    return kind


def _too_large(limit: int) -> str:
    return f"文件大小超出 {limit // (1024 * 1024)} MB 上限，无法使用"


def _content_md5(kind: MediaKind, found: StoredObject) -> str | None:
    if kind != "video" or found.object_type != _NORMAL_OBJECT or found.etag is None:
        return None
    if _MD5_HEX.fullmatch(found.etag) is None:
        return None
    return found.etag.lower()


def _accepted_type(content_type: str) -> tuple[MediaKind, str, str]:
    normalized = content_type.split(";")[0].strip().lower()
    known = UPLOAD_TYPES.get(normalized)
    if known is None:
        allowed = "、".join(sorted(UPLOAD_TYPES))
        raise ValidationFailed(f"不支持 {normalized or '空'} 文件类型，仅支持：{allowed}")
    return known[0], known[1], normalized


def _check_dimensions(width: int, height: int) -> None:
    if min(width, height) < MIN_SHORT_EDGE_PIXELS:
        raise ValidationFailed(
            f"图片尺寸 {width}×{height} 的短边不足 {MIN_SHORT_EDGE_PIXELS}px，无法上传"
        )
    if max(width, height) > MAX_LONG_EDGE_PIXELS:
        raise ValidationFailed(
            f"图片尺寸 {width}×{height} 的长边超出 {MAX_LONG_EDGE_PIXELS}px，请缩放后重试"
        )


__all__ = [
    "ConversationWritable",
    "FetchBytes",
    "UploadLineage",
    "UploadService",
]
