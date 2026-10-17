from __future__ import annotations

from typing import Annotated, Final

from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from pydantic.alias_generators import to_camel

from iclip.domains.uploads.models import ConfirmedUpload

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
    """确认上传时可选的请求体：替谁确认。"""

    user_name: (
        Annotated[
            str,
            StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_USER_NAME_CHARS),
        ]
        | None
    ) = None


class UploadConfirmedOut(CamelModel):
    """确认后交回的地址与桶里读到的事实；``url`` 从此就是这个文件的身份。"""

    url: str
    content_type: str
    size_bytes: int


def confirmed_out(confirmed: ConfirmedUpload) -> UploadConfirmedOut:
    return UploadConfirmedOut(
        url=confirmed.url, content_type=confirmed.content_type, size_bytes=confirmed.size_bytes
    )


__all__ = [
    "MAX_USER_NAME_CHARS",
    "UploadConfirmIn",
    "UploadConfirmedOut",
    "UploadSignIn",
    "confirmed_out",
]
