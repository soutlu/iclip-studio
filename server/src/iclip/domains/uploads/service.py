"""直传签名与确认。签名本地算；确认从桶里读，通过后记一条上传记录。

上传者与 API key 照旧签进 ``x-oss-meta-*`` 请求头随对象存在桶里；记录的属主是确认时的主体。
同一个视频文件只留一个地址：确认时按 MD5 认出重复，交回最早那份的地址，删掉新传的。"""

from __future__ import annotations

import re
import uuid
from datetime import UTC, datetime, timedelta
from typing import Final, Protocol

import structlog

from iclip.common.errors import Conflict, ValidationFailed
from iclip.domains.identity.public import Principal
from iclip.domains.uploads.models import (
    MAX_BYTES,
    MAX_LONG_EDGE_PIXELS,
    MIN_SHORT_EDGE_PIXELS,
    UPLOAD_TYPES,
    ConfirmedUpload,
    MediaKind,
    UploadTicket,
)
from iclip.domains.uploads.schemas import UploadSignIn
from iclip.platform.object_store.layout import MEDIA_PATHS
from iclip.platform.object_store.store import (
    SIGNED_PUT_EXPIRES_SECONDS,
    ObjectStoreUnavailable,
    SignedUploadStore,
    StoredObject,
)

_logger = structlog.stdlib.get_logger(__name__)

UPLOADER_HEADER: Final = "x-oss-meta-uploader"
API_KEY_HEADER: Final = "x-oss-meta-api-key"
"""随对象存进桶的审计元数据：值是 UUID 文本，OSS 只收 ASCII。"""

_NORMAL_OBJECT: Final = "Normal"
"""一次整传的对象类型；只有它的 ETag 是内容的 MD5。"""

_MD5_HEX: Final = re.compile(r"[0-9a-fA-F]{32}")


class RecordedUpload(Protocol):
    """一条上传记录交回的地址，以及这个地址上的对象是哪一次上传传上来的。"""

    @property
    def url(self) -> str: ...

    @property
    def object_upload_id(self) -> uuid.UUID:
        """对象 key 里的 uploadId；与本次的 ``upload_id`` 不同，说明地址是先传的那份。"""
        ...


class RecordUpload(Protocol):
    """把一次确认过的上传记成一条记录，交回这一行最终的地址。行 id 就是 ``upload_id``，重复调用
    不重复落行、不改已有的。给了 ``content_md5`` 且同一个文件已经传过，地址是最早那份的。
    实现由组合根接到生成域。"""

    async def __call__(
        self,
        principal: Principal,
        *,
        upload_id: uuid.UUID,
        kind: MediaKind,
        url: str,
        content_md5: str | None,
    ) -> RecordedUpload: ...


class FindRecordedUpload(Protocol):
    """这次上传记过没有：记过交回那一行的地址，没记过给 ``None``。实现由组合根接到生成域。"""

    async def __call__(self, upload_id: uuid.UUID) -> RecordedUpload | None: ...


class UploadService:
    """直传的两个用例：签许可、按桶确认并记录。"""

    def __init__(
        self,
        objects: SignedUploadStore,
        *,
        record: RecordUpload,
        find_recorded: FindRecordedUpload,
    ) -> None:
        self._objects = objects
        self._record = record
        self._find_recorded = find_recorded

    def sign_upload(self, principal: Principal, body: UploadSignIn) -> UploadTicket:
        kind, ext, normalized = _accepted_type(body.content_type)
        if kind == "image":
            if body.width is None or body.height is None:
                raise ValidationFailed("传图要报宽高")
            _check_dimensions(body.width, body.height)
        headers = {"Content-Type": normalized, UPLOADER_HEADER: str(principal.user_id)}
        if principal.api_key_id is not None:
            headers[API_KEY_HEADER] = str(principal.api_key_id)
        upload_id = uuid.uuid4()
        upload_url = self._objects.sign_put(
            object_key=MEDIA_PATHS.upload(upload_id=upload_id, ext=ext), headers=headers
        )
        return UploadTicket(
            upload_id=upload_id,
            upload_url=upload_url,
            headers=headers,
            # 仅向客户端展示签名有效期，不用于业务判断。
            expires_at=datetime.now(UTC) + timedelta(seconds=SIGNED_PUT_EXPIRES_SECONDS),
        )

    async def confirm(self, principal: Principal, upload_id: uuid.UUID) -> ConfirmedUpload:
        """确认一次上传，交回地址与那个地址上对象的类型、大小。

        还没记过：按桶里本次的对象核对类型与大小，通过后以 ``principal`` 记一条上传；视频带上 MD5，
        同一个文件传过就交回最早那份的地址，删掉本次的对象，删不掉只记一条 warning。核对不过
        （``Conflict`` / ``ValidationFailed``）不记录。

        已经记过：直接交回记录上的地址，不再读本次的对象（去重后它已经删了），类型与大小读那个
        地址上的对象；对象不在桶里了抛 ``Conflict``。可重复调，第二次不改属主。"""

        recorded = await self._find_recorded(upload_id)
        if recorded is None:
            found = await self._objects.find_object(
                prefix=MEDIA_PATHS.upload_prefix(upload_id=upload_id)
            )
            if found is None:
                raise Conflict("这个文件还没传上来，传完再确认")
            kind = _checked_kind(found)
            recorded = await self._record(
                principal,
                upload_id=upload_id,
                kind=kind,
                url=self._objects.public_url(found.object_key),
                content_md5=_content_md5(kind, found),
            )
            if recorded.object_upload_id == upload_id:
                return ConfirmedUpload(
                    url=recorded.url, content_type=found.content_type, size_bytes=found.size_bytes
                )
            await self._discard(found.object_key, upload_id=upload_id)
        return await self._describe(recorded)

    async def _describe(self, recorded: RecordedUpload) -> ConfirmedUpload:
        """按记录交回地址，类型与大小读那个地址上的对象。"""

        found = await self._objects.find_object(
            prefix=MEDIA_PATHS.upload_prefix(upload_id=recorded.object_upload_id)
        )
        if found is None:
            raise Conflict("这个地址上的文件已经不在了，重新上传一次")
        return ConfirmedUpload(
            url=recorded.url, content_type=found.content_type, size_bytes=found.size_bytes
        )

    async def _discard(self, object_key: str, *, upload_id: uuid.UUID) -> None:
        """删掉被换掉地址的那份对象。删不掉不影响确认：地址已经交回，多留一份字节只占空间。"""

        try:
            await self._objects.delete_object(object_key)
        except ObjectStoreUnavailable as exc:
            _logger.warning(
                "重复上传的对象删除失败", upload_id=upload_id, object_key=object_key, error=str(exc)
            )


def _checked_kind(found: StoredObject) -> MediaKind:
    """按桶里的类型定媒体种类并核对大小上限；不收的类型、超限抛 ValidationFailed。"""

    known = UPLOAD_TYPES.get(found.content_type)
    if known is None:
        raise ValidationFailed(f"桶里那个对象的类型是 {found.content_type}，不在收的范围内")
    kind: MediaKind = known[0]
    if found.size_bytes > MAX_BYTES[kind]:
        limit_mb = MAX_BYTES[kind] // (1024 * 1024)
        raise ValidationFailed(f"超过 {limit_mb}MB 上限，这个文件不能用")
    return kind


def _content_md5(kind: MediaKind, found: StoredObject) -> str | None:
    """视频且是一次整传时，ETag 就是内容的 MD5，交回小写十六进制；其余不认，不去重。"""

    if kind != "video" or found.object_type != _NORMAL_OBJECT or found.etag is None:
        return None
    if _MD5_HEX.fullmatch(found.etag) is None:
        return None
    return found.etag.lower()


def _accepted_type(content_type: str) -> tuple[MediaKind, str, str]:
    """返回标准 MIME 类型对应的媒体种类、扩展名和 MIME 类型；不支持的类型抛 ValidationFailed。"""

    normalized = content_type.split(";")[0].strip().lower()
    known = UPLOAD_TYPES.get(normalized)
    if known is None:
        allowed = "、".join(sorted(UPLOAD_TYPES))
        raise ValidationFailed(f"不收 {normalized or '空'} 这个类型，只收：{allowed}")
    return known[0], known[1], normalized


def _check_dimensions(width: int, height: int) -> None:
    """按短边和长边校验客户端申报的尺寸，超限抛 ValidationFailed。"""

    if min(width, height) < MIN_SHORT_EDGE_PIXELS:
        raise ValidationFailed(
            f"{width}×{height} 的短边不到 {MIN_SHORT_EDGE_PIXELS}px，这张图太小了"
        )
    if max(width, height) > MAX_LONG_EDGE_PIXELS:
        raise ValidationFailed(
            f"{width}×{height} 的长边超过 {MAX_LONG_EDGE_PIXELS}px，先缩一下再传"
        )


__all__ = [
    "API_KEY_HEADER",
    "UPLOADER_HEADER",
    "FindRecordedUpload",
    "RecordUpload",
    "RecordedUpload",
    "UploadService",
]
