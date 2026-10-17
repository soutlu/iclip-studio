from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Query, status

from iclip.domains.brand_templates.schemas import (
    BrandFontConfirmIn,
    BrandFontInfoOut,
    BrandFontSignIn,
    BrandTemplateCreateIn,
    BrandTemplateOut,
    BrandTemplatesOut,
    BrandTemplateUpdateIn,
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

        ``includeDisabled`` 连停用的一起列，只限治理者，别人带上是 ``403``。媒体参数按资源实际情况
        返回，不完整的资源也照实列出，由使用它的功能明确校验。"""

        return await service.list(
            principal, kind=kind, brand=brand, include_disabled=include_disabled
        )

    @router.post("", response_model=BrandTemplateOut, status_code=status.HTTP_201_CREATED)
    async def create_brand_template(
        principal: Annotated[Principal, require_permission(MANAGE_PERMISSION)],
        body: BrandTemplateCreateIn,
    ) -> BrandTemplateOut:
        """拿调用者自己的一条视频上传建一条在用的模板（``201``），画幅、时长与音轨由服务端量。

        别人的上传、不是视频的上传、不存在的 ``uploadId`` 都是 ``404``；量不出来或超过时长上限
        是 ``422``。"""

        return await service.create(principal, body)

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
