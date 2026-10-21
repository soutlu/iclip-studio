"""参考视频端点的请求与响应形状，camelCase 别名。术语见 docs/CONTEXT.md「参考视频」。"""

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
"""与 ``generation.schemas.MAX_USER_NAME_CHARS`` 同一个数；参考视频不依赖生成域，照抄。"""


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True
    )


class ReferenceCreateIn(CamelModel):
    upload_id: uuid.UUID
    """调用者自己的一条视频上传（``POST /uploads/{uploadId}/confirm`` 确认过的那个 id）。"""


class ReferenceUpdateIn(CamelModel):
    """改拆解正文。"""

    version: int
    """读到那一份的版本号；对不上是 ``409``。"""
    document: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class ReferenceTagsIn(CamelModel):
    """整份替换这条参考视频在所有维度上的标签。"""

    tag_ids: list[uuid.UUID]
    """取值的 id，不能是维度；重复的去掉，空就是全部清掉。"""


class ReferenceVideoItemOut(CamelModel):
    """列表里的一条参考视频；不带拆解正文，正文在详情里。"""

    id: uuid.UUID
    video_url: str
    user_name: str | None
    """属主的用户名：上传的人，或第一次拆它的人；账号没有用户名时为 ``None``。"""
    tag_ids: list[uuid.UUID]
    """所有维度上的标签，指 ``GET /library-tags`` 里的节点；空就是未标注。"""
    tag_status: TagStatus | None
    """打标状态；还没打过标为 ``null``。"""
    tag_error: TagErrorCode | None
    """最近一次打标失败的原因；打成之后清掉。"""
    breakdown_status: BreakdownStatus
    error_code: BreakdownErrorCode | None
    """最近一次失败的原因；拆成之后清掉。"""
    version: int
    """拆完或改过一次就加一。"""
    can_edit: bool
    """这位读者能不能改、改标签、重拆、重新打标、移除：属主才能。"""
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
    """归属标签，规则同媒体生成。"""


class TestVideoOut(CamelModel):
    """属主名下这条参考视频最新的一次试生成；所有读者看到的是同一条。"""

    status: TestVideoStatus
    """``running`` 还没结束；``completed`` 有试生成结果；``failed`` 没生成成。"""
    url: str | None
    """试生成地址；只有 ``completed`` 有。"""
    error_message: str | None
    """上游给的失败原文，只有 ``failed`` 可能有；不翻译、不归类。"""
    stale: bool
    """当前拆解拼出的提示词与这次试生成用的不同：拆解改过或重拆过，这条出片对照的已不是当前拆解。
    当前拆解拼不出提示词时也为真。"""
    created_at: datetime


class ReferenceVideoOut(ReferenceVideoItemOut):
    """一条参考视频，连同当前拆解与最新的一次试生成。"""

    document: str | None
    """当前拆解的 Markdown 原文；还没拆完过是 ``None``。"""
    test_video: TestVideoOut | None
    """属主名下最新的一次试生成；没有试生成过是 ``None``。"""


class ReferenceVideosOut(CamelModel):
    items: list[ReferenceVideoItemOut]
    next_cursor: str | None
    total: int | None
    """当前筛选下一共几条；只有第一页（不带 ``cursor``）给，翻页时为 ``None``。"""
    can_upload: bool
    """这位读者能不能往资料库加参考视频：拆解已配置，且持 ``uploads:write``。"""


class OwnerCountOut(CamelModel):
    user_name: str
    count: int
    """这个人名下有几条。"""


class ReferenceFiltersOut(CamelModel):
    owners: list[OwnerCountOut]
    """名下有参考视频的属主，条数多的在前，同数按用户名。"""


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
