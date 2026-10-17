from __future__ import annotations

import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Final, Literal

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from iclip.platform.object_store.store import SIGNED_PUT_EXPIRES_SECONDS, SignedUploadStore

UPLOADER_HEADER: Final = "x-oss-meta-uploader"
API_KEY_HEADER: Final = "x-oss-meta-api-key"


def audit_metadata(*, user_id: uuid.UUID, api_key_id: uuid.UUID | None) -> dict[str, str]:
    # OSS 的自定义元数据只收 ASCII。
    metadata = {UPLOADER_HEADER: str(user_id)}
    if api_key_id is not None:
        metadata[API_KEY_HEADER] = str(api_key_id)
    return metadata


@dataclass(frozen=True, slots=True)
class UploadTicket:
    upload_id: uuid.UUID
    upload_url: str
    headers: Mapping[str, str]
    expires_at: datetime


def sign_upload(
    objects: SignedUploadStore,
    *,
    upload_id: uuid.UUID,
    object_key: str,
    content_type: str,
    user_id: uuid.UUID,
    api_key_id: uuid.UUID | None,
) -> UploadTicket:
    headers = {
        "Content-Type": content_type,
        **audit_metadata(user_id=user_id, api_key_id=api_key_id),
    }
    return UploadTicket(
        upload_id=upload_id,
        upload_url=objects.sign_put(object_key=object_key, headers=headers),
        headers=headers,
        expires_at=datetime.now(UTC) + timedelta(seconds=SIGNED_PUT_EXPIRES_SECONDS),
    )


class _CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True
    )


class UploadInstruction(_CamelModel):
    """浏览器照着它直传：往 ``url`` 发一个 PUT，headers 原样带上。

    ``headers`` 全部签进了签名里：Content-Type 限制类型，``x-oss-meta-*`` 记上传者与
    key。少一个、改一个，OSS 那边就验签不过。
    """

    url: str
    method: Literal["PUT"] = "PUT"
    headers: dict[str, str]
    expires_at: datetime


class UploadTicketOut(_CamelModel):
    """一次直传的许可：先拿到名字，再去传。

    ``uploadId`` 在字节落地之前就发下来，因为传这个副作用发生之前，双方必须先就「它
    叫什么」达成一致。确认时用它指这一次上传。
    """

    upload_id: uuid.UUID
    upload: UploadInstruction

    @classmethod
    def of(cls, ticket: UploadTicket) -> UploadTicketOut:
        return cls(
            upload_id=ticket.upload_id,
            upload=UploadInstruction(
                url=ticket.upload_url, headers=dict(ticket.headers), expires_at=ticket.expires_at
            ),
        )


__all__ = [
    "API_KEY_HEADER",
    "UPLOADER_HEADER",
    "UploadInstruction",
    "UploadTicket",
    "UploadTicketOut",
    "audit_metadata",
    "sign_upload",
]
