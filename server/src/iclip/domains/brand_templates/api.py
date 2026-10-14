"""品牌模板 HTTP 端点，约定见合同「资料库」一节。

列表要 ``generation:read``；新建、改名、停用与恢复只限治理者（``users:manage``）。"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Query, status

from iclip.domains.brand_templates.models import Position
from iclip.domains.brand_templates.schemas import (
    BrandTemplateCreateIn,
    BrandTemplateOut,
    BrandTemplatesOut,
    BrandTemplateUpdateIn,
)
from iclip.domains.brand_templates.service import BrandTemplateService
from iclip.domains.identity.public import MANAGE_PERMISSION, Principal, require_permission


def create_brand_templates_router(service: BrandTemplateService) -> APIRouter:
    router = APIRouter(prefix="/brand-templates", tags=["brand-templates"])

    @router.get("", response_model=BrandTemplatesOut)
    async def list_brand_templates(
        principal: Annotated[Principal, require_permission("generation:read")],
        position: Position | None = None,
        include_disabled: Annotated[bool, Query(alias="includeDisabled")] = False,
    ) -> BrandTemplatesOut:
        """品牌模板，建立晚的排前面；默认只列在用的，``position`` 筛片头或片尾。

        ``includeDisabled`` 连停用的一起列，只限治理者，别人带上是 ``403``。每条带画面宽高，前端按
        整片的画面比例自己挑比例相近的。"""

        return await service.list(principal, position=position, include_disabled=include_disabled)

    @router.post("", response_model=BrandTemplateOut, status_code=status.HTTP_201_CREATED)
    async def create_brand_template(
        principal: Annotated[Principal, require_permission(MANAGE_PERMISSION)],
        body: BrandTemplateCreateIn,
    ) -> BrandTemplateOut:
        """拿调用者自己的一条视频上传建一条在用的模板（``201``），画幅、时长与音轨由服务端量。

        别人的上传、不是视频的上传、不存在的 ``uploadId`` 都是 ``404``；量不出来或超过时长上限
        是 ``422``。"""

        return await service.create(principal, body)

    @router.patch("/{template_id}", response_model=BrandTemplateOut)
    async def update_brand_template(
        _: Annotated[Principal, require_permission(MANAGE_PERMISSION)],
        template_id: uuid.UUID,
        body: BrandTemplateUpdateIn,
    ) -> BrandTemplateOut:
        """改名、停用或恢复使用；不删。已有整片里记的是快照，不受影响。没有这条是 ``404``。"""

        return await service.update(template_id, body)

    return router


__all__ = ["create_brand_templates_router"]
