"""品牌模板端点的请求与响应形状，camelCase 别名。术语见 docs/CONTEXT.md「资料库」。"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Final, Literal

from pydantic import BaseModel, ConfigDict, StringConstraints, model_validator
from pydantic.alias_generators import to_camel

from iclip.domains.brand_templates.models import BrandTemplate, FontUploadTicket, Position
from iclip.platform.media.fonts import FontInfo

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
    kind: Position
    brand: TemplateName | None = None
    name: TemplateName
    upload_id: uuid.UUID
    """调用者自己的一条视频上传（``POST /uploads/{uploadId}/confirm`` 确认过的那个 id）。"""


class BrandTemplateUpdateIn(CamelModel):
    """改名、停用或恢复使用；不给的那一项不动，至少给一项。"""

    name: TemplateName | None = None
    brand: TemplateName | None = None
    """省略不改，显式 null 清空品牌。"""
    disabled: bool | None = None
    """``true`` 停用，``false`` 恢复使用。"""

    @model_validator(mode="after")
    def _something_to_change(self) -> BrandTemplateUpdateIn:
        if self.name is None and self.disabled is None and "brand" not in self.model_fields_set:
            raise ValueError("name、brand 与 disabled 至少给一项")
        return self


class BrandTemplateOut(CamelModel):
    id: uuid.UUID
    kind: str
    brand: str | None
    name: str
    url: str
    """品牌资源的地址。"""
    width: int | None
    height: int | None
    """画面的宽高（像素）：前端按整片的画面比例挑比例相近的模板。"""
    duration_ms: int | None
    has_audio: bool | None
    """模板视频有没有音轨；没有的在整片里补静音。"""
    created_at: datetime
    disabled_at: datetime | None
    """为空表示在用。"""

    @classmethod
    def of(cls, template: BrandTemplate) -> BrandTemplateOut:
        return cls(
            id=template.id,
            kind=template.kind,
            brand=template.brand,
            name=template.name,
            url=template.url,
            width=template.width,
            height=template.height,
            duration_ms=template.duration_ms,
            has_audio=template.has_audio,
            created_at=template.created_at,
            disabled_at=template.disabled_at,
        )


class BrandTemplatesOut(CamelModel):
    items: list[BrandTemplateOut]


class BrandFontSignIn(CamelModel):
    content_type: Literal["font/ttf", "font/otf"]


class BrandFontConfirmIn(CamelModel):
    name: TemplateName
    brand: TemplateName | None = None


class BrandFontUploadInstruction(CamelModel):
    url: str
    method: Literal["PUT"] = "PUT"
    headers: dict[str, str]
    expires_at: datetime


class BrandFontUploadTicketOut(CamelModel):
    upload_id: uuid.UUID
    upload: BrandFontUploadInstruction

    @classmethod
    def of(cls, ticket: FontUploadTicket) -> BrandFontUploadTicketOut:
        return cls(
            upload_id=ticket.upload_id,
            upload=BrandFontUploadInstruction(
                url=ticket.upload_url, headers=ticket.headers, expires_at=ticket.expires_at
            ),
        )


class BrandFontUnicodeRange(CamelModel):
    start: int
    end: int


class BrandFontInfoOut(CamelModel):
    family: str
    weight: int
    style: Literal["normal", "italic", "oblique"]
    unicode_ranges: list[BrandFontUnicodeRange]
    """字体实际覆盖的 Unicode 闭区间，按起点递增且已合并相邻范围。"""

    @classmethod
    def of(cls, info: FontInfo) -> BrandFontInfoOut:
        return cls(
            family=info.family,
            weight=info.weight,
            style=info.style,
            unicode_ranges=[
                BrandFontUnicodeRange(start=start, end=end) for start, end in info.unicode_ranges
            ],
        )


__all__ = [
    "MAX_NAME_CHARS",
    "BrandFontConfirmIn",
    "BrandFontInfoOut",
    "BrandFontSignIn",
    "BrandFontUploadTicketOut",
    "BrandTemplateCreateIn",
    "BrandTemplateOut",
    "BrandTemplateUpdateIn",
    "BrandTemplatesOut",
]
