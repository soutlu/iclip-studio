from __future__ import annotations

import re
import uuid
from typing import Final, Protocol

import structlog
from agent_runtime.errors import Conflict, ValidationFailed

from iclip.domains.identity.public import Principal
from iclip.domains.uploads.models import (
    MAX_BYTES,
    MAX_LONG_EDGE_PIXELS,
    MIN_SHORT_EDGE_PIXELS,
    UPLOAD_TYPES,
    ConfirmedUpload,
    MediaKind,
)
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
from iclip.platform.outbound.guard import FetchFailed, FetchRefused

_logger = structlog.stdlib.get_logger(__name__)

# OSS 只有一次整传（Normal）的对象 ETag 才是内容的 MD5。
_NORMAL_OBJECT: Final = "Normal"

_MD5_HEX: Final = re.compile(r"[0-9a-fA-F]{32}")


class RecordedUpload(Protocol):
    @property
    def url(self) -> str: ...

    @property
    def object_upload_id(self) -> uuid.UUID: ...


class RecordUpload(Protocol):
    async def __call__(
        self,
        principal: Principal,
        *,
        upload_id: uuid.UUID,
        kind: MediaKind,
        url: str,
        content_md5: str | None,
        conversation_id: uuid.UUID | None,
    ) -> RecordedUpload: ...


class ConversationWritable(Protocol):
    """主体能不能改这段对话：看不见抛 ``NotFound``，看得见却不是属主（或已删除）抛
    ``PermissionDenied``。由组合根接到对话域。"""

    async def __call__(self, principal: Principal, conversation_id: uuid.UUID, /) -> object: ...


class FindRecordedUpload(Protocol):
    async def __call__(self, upload_id: uuid.UUID) -> RecordedUpload | None: ...


class FetchBytes(Protocol):
    async def __call__(self, url: str, *, max_bytes: int) -> bytes: ...


class UploadService:
    def __init__(
        self,
        objects: PublicBucket,
        *,
        record: RecordUpload,
        find_recorded: FindRecordedUpload,
        fetch: FetchBytes,
        conversation_writable: ConversationWritable,
    ) -> None:
        self._objects = objects
        self._record = record
        self._find_recorded = find_recorded
        self._fetch = fetch
        self._conversation_writable = conversation_writable

    def sign_upload(self, principal: Principal, body: UploadSignIn) -> UploadTicket:
        kind, ext, normalized = _accepted_type(body.content_type)
        if kind == "image":
            if body.width is None or body.height is None:
                raise ValidationFailed("传图要报宽高")
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
    ) -> ConfirmedUpload:
        """``conversation_id`` 只收音乐，主体要是那段对话的属主；记过的上传照旧交回，不再看它。"""

        recorded = await self._find_recorded(upload_id)
        if recorded is None:
            found = await self._objects.find_object(
                prefix=MEDIA_PATHS.upload_prefix(upload_id=upload_id)
            )
            if found is None:
                raise Conflict("这个文件还没传上来，传完再确认")
            kind = _checked_kind(found)
            if conversation_id is not None:
                if kind != "audio":
                    raise ValidationFailed("只有音乐能挂到对话上")
                await self._conversation_writable(principal, conversation_id)
            recorded = await self._record(
                principal,
                upload_id=upload_id,
                kind=kind,
                url=self._objects.public_url(found.object_key),
                content_md5=_content_md5(kind, found),
                conversation_id=conversation_id,
            )
            if recorded.object_upload_id == upload_id:
                return ConfirmedUpload(
                    url=recorded.url, content_type=found.content_type, size_bytes=found.size_bytes
                )
            await self._discard_duplicate(found.object_key, upload_id=upload_id)
        return await self._describe(recorded)

    async def import_image(self, principal: Principal, url: str, *, upload_id: uuid.UUID) -> str:
        recorded = await self._find_recorded(upload_id)
        if recorded is not None:
            return recorded.url
        limit = MAX_BYTES["image"]
        try:
            content = await self._fetch(url, max_bytes=limit)
        except FetchTooLarge as exc:
            raise ValidationFailed(_too_large(limit)) from exc
        except FetchRefused as exc:
            raise ValidationFailed(f"这个地址不允许服务端下载：{exc}") from exc
        except FetchFailed as exc:
            raise ValidationFailed(f"这张图下载不下来：{exc}") from exc
        if len(content) > limit:
            raise ValidationFailed(_too_large(limit))
        header = read_image_header(content)
        if header is None:
            raise ValidationFailed("下载下来的不是能读的图片")
        known = UPLOAD_TYPES.get(header.mime or "")
        if header.mime is None or known is None or known[0] != "image":
            allowed = "、".join(
                sorted(mime for mime, (kind, _) in UPLOAD_TYPES.items() if kind == "image")
            )
            raise ValidationFailed(
                f"下载下来的图片是 {header.mime or '认不出类型的'} 格式，只收：{allowed}"
            )
        _check_dimensions(header.width, header.height)
        stored = await self._objects.put_public_object(
            object_key=MEDIA_PATHS.upload(upload_id=upload_id, ext=known[1]),
            content=content,
            content_type=header.mime,
            metadata=audit_metadata(user_id=principal.user_id, api_key_id=principal.api_key_id),
        )
        recorded = await self._record(
            principal,
            upload_id=upload_id,
            kind="image",
            url=stored,
            content_md5=None,
            conversation_id=None,
        )
        return recorded.url

    async def _describe(self, recorded: RecordedUpload) -> ConfirmedUpload:
        found = await self._objects.find_object(
            prefix=MEDIA_PATHS.upload_prefix(upload_id=recorded.object_upload_id)
        )
        if found is None:
            raise Conflict("这个地址上的文件已经不在了，重新上传一次")
        return ConfirmedUpload(
            url=recorded.url, content_type=found.content_type, size_bytes=found.size_bytes
        )

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
        raise ValidationFailed(f"桶里那个对象的类型是 {found.content_type}，不在收的范围内")
    kind: MediaKind = known[0]
    if found.size_bytes > MAX_BYTES[kind]:
        raise ValidationFailed(_too_large(MAX_BYTES[kind]))
    return kind


def _too_large(limit: int) -> str:
    return f"超过 {limit // (1024 * 1024)}MB 上限，这个文件不能用"


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
        raise ValidationFailed(f"不收 {normalized or '空'} 这个类型，只收：{allowed}")
    return known[0], known[1], normalized


def _check_dimensions(width: int, height: int) -> None:
    if min(width, height) < MIN_SHORT_EDGE_PIXELS:
        raise ValidationFailed(
            f"{width}×{height} 的短边不到 {MIN_SHORT_EDGE_PIXELS}px，这张图太小了"
        )
    if max(width, height) > MAX_LONG_EDGE_PIXELS:
        raise ValidationFailed(
            f"{width}×{height} 的长边超过 {MAX_LONG_EDGE_PIXELS}px，先缩一下再传"
        )


__all__ = [
    "ConversationWritable",
    "FetchBytes",
    "FindRecordedUpload",
    "RecordUpload",
    "RecordedUpload",
    "UploadService",
]
