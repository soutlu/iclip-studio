"""品牌模板端点的请求与响应形状，camelCase 别名。术语见 docs/CONTEXT.md「资料库」。"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Final

from pydantic import BaseModel, ConfigDict, StringConstraints, model_validator
from pydantic.alias_generators import to_camel

from iclip.domains.brand_templates.models import BrandTemplate, Position

MAX_NAME_CHARS: Final = 100
"""模板名称的字数上限：给管理员在列表里认的名字，不是正文。"""

TemplateName = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_NAME_CHARS)
]
"""去掉首尾空白后不能为空。"""


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True
    )


class BrandTemplateCreateIn(CamelModel):
    position: Position
    name: TemplateName
    upload_id: uuid.UUID
    """调用者自己的一条视频上传（``POST /uploads/{uploadId}/confirm`` 确认过的那个 id）。"""


class BrandTemplateUpdateIn(CamelModel):
    """改名、停用或恢复使用；不给的那一项不动，至少给一项。"""

    name: TemplateName | None = None
    disabled: bool | None = None
    """``true`` 停用，``false`` 恢复使用。"""

    @model_validator(mode="after")
    def _something_to_change(self) -> BrandTemplateUpdateIn:
        if self.name is None and self.disabled is None:
            raise ValueError("name 与 disabled 至少给一项")
        return self


class BrandTemplateOut(CamelModel):
    id: uuid.UUID
    position: Position
    name: str
    url: str
    """模板视频的地址。"""
    width: int
    height: int
    """画面的宽高（像素）：前端按整片的画面比例挑比例相近的模板。"""
    duration_ms: int
    has_audio: bool
    """模板视频有没有音轨；没有的在整片里补静音。"""
    created_at: datetime
    disabled_at: datetime | None
    """为空表示在用。"""

    @classmethod
    def of(cls, template: BrandTemplate) -> BrandTemplateOut:
        return cls(
            id=template.id,
            position=template.position,
            name=template.name,
            url=template.video_url,
            width=template.width,
            height=template.height,
            duration_ms=template.duration_ms,
            has_audio=template.has_audio,
            created_at=template.created_at,
            disabled_at=template.disabled_at,
        )


class BrandTemplatesOut(CamelModel):
    items: list[BrandTemplateOut]


__all__ = [
    "MAX_NAME_CHARS",
    "BrandTemplateCreateIn",
    "BrandTemplateOut",
    "BrandTemplateUpdateIn",
    "BrandTemplatesOut",
]
