from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Final

from pydantic import BaseModel, ConfigDict, StringConstraints, model_validator
from pydantic.alias_generators import to_camel

from iclip.common.brand_vocab import BrandPosition
from iclip.domains.brand_templates.models import BrandTemplate, FontContentType
from iclip.platform.media.fonts import FontInfo, FontStyle

MAX_NAME_CHARS: Final = 100

TemplateName = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_NAME_CHARS)
]


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True
    )


class BrandTemplateCreateIn(CamelModel):
    kind: BrandPosition
    brand: TemplateName | None = None
    name: TemplateName
    upload_id: uuid.UUID


class BrandTemplateUpdateIn(CamelModel):
    """改名、停用或恢复使用；不给的那一项不动，至少给一项。"""

    name: TemplateName | None = None
    brand: TemplateName | None = None
    disabled: bool | None = None

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
    width: int | None
    height: int | None
    duration_ms: int | None
    has_audio: bool | None
    created_at: datetime
    disabled_at: datetime | None

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
    content_type: FontContentType


class BrandFontConfirmIn(CamelModel):
    name: TemplateName
    brand: TemplateName | None = None


class BrandFontUnicodeRange(CamelModel):
    start: int
    end: int


class BrandFontInfoOut(CamelModel):
    family: str
    weight: int
    style: FontStyle
    unicode_ranges: list[BrandFontUnicodeRange]

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
    "BrandTemplateCreateIn",
    "BrandTemplateOut",
    "BrandTemplateUpdateIn",
    "BrandTemplatesOut",
]
