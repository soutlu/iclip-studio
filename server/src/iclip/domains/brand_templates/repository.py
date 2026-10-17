from __future__ import annotations

import uuid
from collections.abc import Sequence
from typing import Protocol

from iclip.domains.brand_templates.models import BrandProfile, BrandTemplate


class BrandTemplateStore(Protocol):
    async def create(
        self,
        *,
        resource_id: uuid.UUID,
        kind: str,
        brand: str | None,
        name: str,
        url: str,
        created_by: uuid.UUID,
        api_key_id: uuid.UUID | None,
    ) -> BrandTemplate: ...

    async def get(self, template_id: uuid.UUID) -> BrandTemplate | None: ...

    async def list(
        self, *, kind: str | None, brand: str | None, include_disabled: bool
    ) -> Sequence[BrandTemplate]: ...

    async def update(
        self,
        template_id: uuid.UUID,
        *,
        name: str | None,
        disabled: bool | None,
        brand: str | None = None,
        update_brand: bool = False,
    ) -> BrandTemplate | None: ...


class BrandProfileStore(Protocol):
    async def brands(self) -> Sequence[BrandProfile]:
        """设过标语或强调色的品牌，并上在用资源里出现过的品牌，按品牌名排。"""
        ...

    async def save(
        self,
        brand: str,
        *,
        slogan: str | None,
        accent_color: str | None,
        updated_by: uuid.UUID,
    ) -> BrandProfile:
        """整份写入这个品牌的标语与强调色，没有就新建。"""
        ...


__all__ = ["BrandProfileStore", "BrandTemplateStore"]
