from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Final

from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from pydantic.alias_generators import to_camel

from iclip.domains.uploads.models import MediaKind, MediaUpload

MAX_USER_NAME_CHARS: Final = 200


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True
    )


class UploadSignIn(CamelModel):
    """要传什么类型、图有多大。类型的取值范围见 ``models.UPLOAD_TYPES``。"""

    content_type: str = Field(min_length=1, max_length=100)
    width: int | None = Field(default=None, ge=1)
    height: int | None = Field(default=None, ge=1)


class UploadConfirmIn(CamelModel):
    """确认上传时可选的请求体：替谁确认，挂到哪段对话，图片多大（签名时报的那两个数）。"""

    user_name: (
        Annotated[
            str,
            StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_USER_NAME_CHARS),
        ]
        | None
    ) = None
    conversation_id: uuid.UUID | None = None
    width: int | None = Field(default=None, ge=1)
    height: int | None = Field(default=None, ge=1)


class UploadOut(CamelModel):
    """上传台账里的一条。``url`` 从此就是这个文件的身份；视频按 MD5 去重时是最早那份的地址。

    ``contentType`` 与 ``sizeBytes`` 只有台账建立以前的旧上传为空。``width`` / ``height`` 是图片
    确认时报的宽高，没报的、别的种类为空。确认上传不量时长，``durationMs`` 为空。
    """

    id: uuid.UUID
    kind: MediaKind
    url: str
    content_type: str | None
    size_bytes: int | None
    duration_ms: int | None
    width: int | None
    height: int | None
    conversation_id: uuid.UUID | None
    created_at: datetime


class UploadsPageOut(CamelModel):
    items: list[UploadOut]


def upload_out(upload: MediaUpload) -> UploadOut:
    return UploadOut(
        id=upload.id,
        kind=upload.kind,
        url=upload.url,
        content_type=upload.content_type,
        size_bytes=upload.size_bytes,
        duration_ms=upload.duration_ms,
        width=upload.width,
        height=upload.height,
        conversation_id=upload.conversation_id,
        created_at=upload.created_at,
    )


__all__ = [
    "MAX_USER_NAME_CHARS",
    "UploadConfirmIn",
    "UploadOut",
    "UploadSignIn",
    "UploadsPageOut",
    "upload_out",
]
