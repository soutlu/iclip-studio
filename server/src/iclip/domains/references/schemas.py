from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Final, Literal

from pydantic import BaseModel, ConfigDict, StringConstraints
from pydantic.alias_generators import to_camel

from iclip.domains.references.models import (
    BreakdownErrorCode,
    BreakdownStatus,
    TestVideoStatus,
)
from iclip.domains.tagging.public import TagErrorCode, TagStatus

MAX_USER_NAME_CHARS: Final = 200


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True
    )


class ReferenceCreateIn(CamelModel):
    upload_id: uuid.UUID


class ReferenceUpdateIn(CamelModel):
    """改拆解正文。"""

    version: int
    document: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class ReferenceTagsIn(CamelModel):
    """整份替换这条参考视频在所有维度上的标签。"""

    tag_ids: list[uuid.UUID]


class ReferenceVideoItemOut(CamelModel):
    """列表里的一条参考视频；不带拆解正文，正文在详情里。"""

    id: uuid.UUID
    video_url: str
    user_name: str | None
    tag_ids: list[uuid.UUID]
    tag_status: TagStatus | None
    tag_error: TagErrorCode | None
    breakdown_status: BreakdownStatus
    error_code: BreakdownErrorCode | None
    version: int
    can_edit: bool
    created_at: datetime
    updated_at: datetime


class TestVideoIn(CamelModel):
    """试生成的请求：画幅与归属标签由调用方定，其余参数服务端定。"""

    aspect_ratio: Literal["9:16", "16:9", "1:1", "3:4", "4:3"]
    user_name: (
        Annotated[
            str,
            StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_USER_NAME_CHARS),
        ]
        | None
    ) = None


class TestVideoOut(CamelModel):
    """属主名下这条参考视频最新的一次试生成；所有读者看到的是同一条。"""

    status: TestVideoStatus
    url: str | None
    error_message: str | None
    stale: bool
    created_at: datetime


class ReferenceVideoOut(ReferenceVideoItemOut):
    """一条参考视频，连同当前拆解与最新的一次试生成。"""

    document: str | None
    test_video: TestVideoOut | None


class ReferenceVideosOut(CamelModel):
    items: list[ReferenceVideoItemOut]
    next_cursor: str | None
    total: int | None
    can_upload: bool


class OwnerCountOut(CamelModel):
    user_name: str
    count: int


class ReferenceFiltersOut(CamelModel):
    owners: list[OwnerCountOut]


__all__ = [
    "MAX_USER_NAME_CHARS",
    "OwnerCountOut",
    "ReferenceCreateIn",
    "ReferenceFiltersOut",
    "ReferenceTagsIn",
    "ReferenceUpdateIn",
    "ReferenceVideoItemOut",
    "ReferenceVideoOut",
    "ReferenceVideosOut",
    "TestVideoIn",
    "TestVideoOut",
]
