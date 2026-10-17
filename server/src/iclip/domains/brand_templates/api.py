from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Path, Query

from iclip.domains.brand_templates.schemas import (
    BrandFontConfirmIn,
    BrandFontInfoOut,
    BrandFontSignIn,
    BrandProfileIn,
    BrandProfileOut,
    BrandProfilesOut,
    BrandTemplateOut,
    BrandTemplatesOut,
    BrandTemplateUpdateIn,
    TemplateName,
)
from iclip.domains.brand_templates.service import BrandTemplateService
from iclip.domains.identity.public import MANAGE_PERMISSION, Principal, require_permission
from iclip.platform.object_store.direct_upload import UploadTicketOut


def create_brand_templates_router(service: BrandTemplateService) -> APIRouter:
    router = APIRouter(prefix="/brand-templates", tags=["brand-templates"])

    @router.get("", response_model=BrandTemplatesOut)
    async def list_brand_templates(
        principal: Annotated[Principal, require_permission("generation:read")],
        kind: str | None = None,
        brand: str | None = None,
        include_disabled: Annotated[bool, Query(alias="includeDisabled")] = False,
    ) -> BrandTemplatesOut:
        """品牌资源，建立晚的排前面；默认只列在用的，按 ``kind`` 与 ``brand`` 筛选。

        ``includeDisabled`` 连停用的一起列，只限治理者，别人带上是 ``403``。"""

        return await service.list(
            principal, kind=kind, brand=brand, include_disabled=include_disabled
        )

    @router.get("/brands", response_model=BrandProfilesOut)
    async def list_brands(
        _: Annotated[Principal, require_permission("generation:read")],
    ) -> BrandProfilesOut:
        """全部品牌连同标语与强调色，按品牌名排。

        品牌取设过标语或强调色的，并上在用资源里出现过的；没设过的两项为 ``null``。"""

        return await service.brands()

    @router.put("/brands/{brand}", response_model=BrandProfileOut)
    async def save_brand(
        principal: Annotated[Principal, require_permission(MANAGE_PERMISSION)],
        brand: Annotated[TemplateName, Path()],
        body: BrandProfileIn,
    ) -> BrandProfileOut:
        """整份写入这个品牌的标语与强调色，没有就新建；``null`` 清空那一项。

        品牌名去掉首尾空白后为 1 到 100 字，答复里是去掉空白后的名字。标语至多 100 字，
        强调色是 ``#RRGGBB``，存成小写。"""

        return await service.save_brand(principal, brand, body)

    @router.post("/fonts/sign", response_model=UploadTicketOut)
    async def sign_font(
        body: BrandFontSignIn,
        principal: Annotated[Principal, require_permission(MANAGE_PERMISSION, "uploads:write")],
    ) -> UploadTicketOut:
        return UploadTicketOut.of(service.sign_font(principal, body))

    @router.post("/fonts/{upload_id}/confirm", response_model=BrandTemplateOut, status_code=201)
    async def confirm_font(
        upload_id: uuid.UUID,
        body: BrandFontConfirmIn,
        principal: Annotated[Principal, require_permission(MANAGE_PERMISSION, "uploads:write")],
    ) -> BrandTemplateOut:
        return await service.confirm_font(principal, upload_id, body)

    @router.get("/{template_id}/font-info", response_model=BrandFontInfoOut)
    async def font_info(
        template_id: uuid.UUID,
        _: Annotated[Principal, require_permission("generation:read")],
    ) -> BrandFontInfoOut:
        return await service.font_info(template_id)

    @router.patch("/{template_id}", response_model=BrandTemplateOut)
    async def update_brand_template(
        _: Annotated[Principal, require_permission(MANAGE_PERMISSION)],
        template_id: uuid.UUID,
        body: BrandTemplateUpdateIn,
    ) -> BrandTemplateOut:
        """改名、停用或恢复使用；不删。没有这条是 ``404``。"""

        return await service.update(template_id, body)

    return router


__all__ = ["create_brand_templates_router"]
