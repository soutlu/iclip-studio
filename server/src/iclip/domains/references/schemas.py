"""参考视频端点的请求与响应形状，camelCase 别名。术语见 docs/CONTEXT.md「参考视频」。"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, ConfigDict, StringConstraints
from pydantic.alias_generators import to_camel

from iclip.domains.references.models import (
    BreakdownErrorCode,
    BreakdownStatus,
    CategoryValue,
    VideoTypeValue,
)


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True
    )


class ReferenceCreateIn(CamelModel):
    upload_id: uuid.UUID
    """调用者自己的一条视频上传（``POST /uploads/{uploadId}/confirm`` 确认过的那个 id）。"""


class ReferenceUpdateIn(CamelModel):
    """整份改：拆解正文与两组标签都照给的存，重复的标签去掉。"""

    version: int
    """读到那一份的版本号；对不上是 ``409``。"""
    document: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
    video_types: list[VideoTypeValue]
    categories: list[CategoryValue]


class ReferenceVideoItemOut(CamelModel):
    """列表里的一条参考视频；不带拆解正文，正文在详情里。"""

    id: uuid.UUID
    video_url: str
    user_name: str | None
    """属主的用户名：上传的人，或第一次拆它的人；账号没有用户名时为 ``None``。"""
    video_types: list[VideoTypeValue]
    """可以几个；空就是未标注。"""
    categories: list[CategoryValue]
    breakdown_status: BreakdownStatus
    error_code: BreakdownErrorCode | None
    """最近一次失败的原因；拆成之后清掉。"""
    version: int
    """拆完或改过一次就加一。"""
    can_edit: bool
    """这位读者能不能改、重拆、移除：属主才能。"""
    created_at: datetime
    updated_at: datetime


class ReferenceVideoOut(ReferenceVideoItemOut):
    """一条参考视频，连同当前拆解。"""

    document: str | None
    """当前拆解的 Markdown 原文；还没拆完过是 ``None``。"""


class ReferenceVideosOut(CamelModel):
    items: list[ReferenceVideoItemOut]
    next_cursor: str | None
    total: int | None
    """当前筛选下一共几条；只有第一页（不带 ``cursor``）给，翻页时为 ``None``。"""
    can_upload: bool
    """这位读者能不能往资料库加参考视频：拆解已配置，且持 ``uploads:write``。"""


class VideoTypeCountOut(CamelModel):
    value: VideoTypeValue
    label: str
    rule: str
    """怎么判断这一类，与打标提示词里写的同一句。"""
    count: int


class CategoryCountOut(CamelModel):
    name: CategoryValue
    count: int


class OwnerCountOut(CamelModel):
    user_name: str
    count: int
    """这个人名下有几条。"""


class ReferenceFiltersOut(CamelModel):
    video_types: list[VideoTypeCountOut]
    """全部片子类型，按清单的先后，没用到的数量为 0。"""
    categories: list[CategoryCountOut]
    """用到的品类，条数多的在前，同数按清单的先后。"""
    owners: list[OwnerCountOut]
    """名下有参考视频的属主，条数多的在前，同数按用户名。"""


__all__ = [
    "CategoryCountOut",
    "OwnerCountOut",
    "ReferenceCreateIn",
    "ReferenceFiltersOut",
    "ReferenceUpdateIn",
    "ReferenceVideoItemOut",
    "ReferenceVideoOut",
    "ReferenceVideosOut",
    "VideoTypeCountOut",
]
