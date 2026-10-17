from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Final

from pydantic import AfterValidator, BaseModel, ConfigDict, StringConstraints, model_validator
from pydantic.alias_generators import to_camel

from iclip.domains.brand_templates.models import BrandProfile, BrandTemplate, FontContentType
from iclip.platform.media.fonts import FontInfo, FontStyle

MAX_NAME_CHARS: Final = 100
MAX_SLOGAN_CHARS: Final = 100

TemplateName = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_NAME_CHARS)
]

Slogan = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_SLOGAN_CHARS)
]

AccentColor = Annotated[
    str,
    StringConstraints(pattern=r"^#[0-9A-Fa-f]{6}$"),
    AfterValidator(str.lower),
]
"""``#RRGGBB``，大小写都收，存小写。"""


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True
    )


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
            created_at=template.created_at,
            disabled_at=template.disabled_at,
        )


class BrandTemplatesOut(CamelModel):
    items: list[BrandTemplateOut]


class BrandProfileIn(CamelModel):
    """整份写入一个品牌的标语与强调色；两项都要给，``null`` 清空。"""

    slogan: Slogan | None
    accent_color: AccentColor | None


class BrandProfileOut(CamelModel):
    brand: str
    slogan: str | None
    accent_color: str | None

    @classmethod
    def of(cls, profile: BrandProfile) -> BrandProfileOut:
        return cls(brand=profile.brand, slogan=profile.slogan, accent_color=profile.accent_color)


class BrandProfilesOut(CamelModel):
    items: list[BrandProfileOut]


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
    "MAX_SLOGAN_CHARS",
    "BrandFontConfirmIn",
    "BrandFontInfoOut",
    "BrandFontSignIn",
    "BrandProfileIn",
    "BrandProfileOut",
    "BrandProfilesOut",
    "BrandTemplateOut",
    "BrandTemplateUpdateIn",
    "BrandTemplatesOut",
    "TemplateName",
]
