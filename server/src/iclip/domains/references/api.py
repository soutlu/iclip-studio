"""参考视频 HTTP 端点，约定见合同「参考视频」一节。

读要 ``generation:read``；建行要 ``uploads:write``；重拆是一次付费调用，另要 ``generation:submit``；
修改与移除只要读权限，属主检查在用例里。拆解没配置时只挂读端点。"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Query, Response, status

from iclip.domains.identity.public import Principal, require_permission
from iclip.domains.references.models import CategoryValue, VideoTypeValue
from iclip.domains.references.schemas import (
    ReferenceCreateIn,
    ReferenceFiltersOut,
    ReferenceUpdateIn,
    ReferenceVideoOut,
    ReferenceVideosOut,
)
from iclip.domains.references.service import ReferenceService
from iclip.platform.paging import DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT


def create_references_router(service: ReferenceService, *, writable: bool) -> APIRouter:
    """``writable`` 为假（拆解没配置）时不挂建行与重拆。"""

    router = APIRouter(prefix="/references", tags=["references"])

    @router.get("", response_model=ReferenceVideosOut)
    async def list_references(
        principal: Annotated[Principal, require_permission("generation:read")],
        video_types: Annotated[list[VideoTypeValue] | None, Query(alias="videoTypes")] = None,
        categories: Annotated[list[CategoryValue] | None, Query()] = None,
        user_name: Annotated[str | None, Query(alias="userName", max_length=150)] = None,
        q: Annotated[str | None, Query(max_length=100)] = None,
        since: datetime | None = None,
        until: datetime | None = None,
        limit: Annotated[int, Query(ge=1, le=MAX_LIST_LIMIT)] = DEFAULT_LIST_LIMIT,
        cursor: str | None = None,
    ) -> ReferenceVideosOut:
        """全站没移除的参考视频，建立晚的排前面。

        ``videoTypes``、``categories`` 可以重复给，同一组里命中任一即算；``userName`` 筛属主；``q``
        按字面包含匹配拆解全文；时间窗 ``[since, until)`` 作用在建立时刻上。``total`` 只在第一页给。
        """

        return await service.list(
            principal,
            video_types=video_types or (),
            categories=categories or (),
            user_name=user_name,
            q=q,
            since=since,
            until=until,
            limit=limit,
            cursor=cursor,
        )

    # 写在 /{reference_id} 之前，否则 filters 会被当成 id 解析。
    @router.get("/filters", response_model=ReferenceFiltersOut)
    async def reference_filters(
        _: Annotated[Principal, require_permission("generation:read")],
    ) -> ReferenceFiltersOut:
        """全部片子类型与用到的品类，各带条数；只数没移除的，不受筛选影响。"""

        return await service.filters()

    @router.get("/{reference_id}", response_model=ReferenceVideoOut)
    async def get_reference(
        principal: Annotated[Principal, require_permission("generation:read")],
        reference_id: uuid.UUID,
    ) -> ReferenceVideoOut:
        """一条参考视频连同当前拆解；移除了是 ``404``。"""

        return await service.get(principal, reference_id)

    @router.patch("/{reference_id}", response_model=ReferenceVideoOut)
    async def update_reference(
        principal: Annotated[Principal, require_permission("generation:read")],
        reference_id: uuid.UUID,
        body: ReferenceUpdateIn,
    ) -> ReferenceVideoOut:
        """属主改拆解正文与两组标签，版本加一。版本对不上或正在拆解是 ``409``，别人的是 ``403``。"""

        return await service.update(principal, reference_id, body)

    @router.delete("/{reference_id}", status_code=status.HTTP_204_NO_CONTENT)
    async def remove_reference(
        principal: Annotated[Principal, require_permission("generation:read")],
        reference_id: uuid.UUID,
    ) -> None:
        """属主把它从资料库移除；AI 导演按地址仍能用它的拆解。别人的是 ``403``。"""

        await service.remove(principal, reference_id)

    if writable:

        @router.post("", response_model=ReferenceVideoOut, status_code=status.HTTP_201_CREATED)
        async def create_reference(
            principal: Annotated[Principal, require_permission("uploads:write")],
            body: ReferenceCreateIn,
            response: Response,
        ) -> ReferenceVideoOut:
            """把调用者自己的一条视频上传放进资料库，新建的排上第一次拆解（``201``）。

            同一条视频已在表里就交回那一行（``200``），不再拆；移除过的回到资料库。别人的上传、
            不是视频的上传、不存在的 ``uploadId`` 都是 ``404``。"""

            created_row, created = await service.create(principal, body.upload_id)
            if not created:
                response.status_code = status.HTTP_200_OK
            return created_row

        @router.post("/{reference_id}/breakdowns", response_model=ReferenceVideoOut)
        async def rerun_reference(
            principal: Annotated[
                Principal, require_permission("generation:read", "generation:submit")
            ],
            reference_id: uuid.UUID,
        ) -> ReferenceVideoOut:
            """属主重新拆解：重新排队，拆成就覆盖拆解与标签，失败保留原来的。正在拆是 ``409``。"""

            return await service.rerun(principal, reference_id)

    return router


__all__ = ["create_references_router"]
