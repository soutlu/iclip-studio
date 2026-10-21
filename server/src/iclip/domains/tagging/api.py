"""资料库标签 HTTP 端点，约定见合同「标签」一节。"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Response

from iclip.domains.identity.public import Principal, require_permission
from iclip.domains.tagging.schemas import (
    LibraryTagCreateIn,
    LibraryTagOut,
    LibraryTagsOut,
    LibraryTagUpdateIn,
)
from iclip.domains.tagging.service import TaggingService


def create_tagging_router(service: TaggingService) -> APIRouter:
    router = APIRouter(prefix="/library-tags", tags=["library-tags"])

    @router.get("", response_model=LibraryTagsOut)
    async def library_tags(
        _: Annotated[Principal, require_permission("generation:read")],
    ) -> LibraryTagsOut:
        """整棵标签树，每个标签带灵感库与爆款素材库里各有几条带它或它的下级。"""

        return await service.tree()

    @router.post("", response_model=LibraryTagOut, status_code=201)
    async def create_library_tag(
        body: LibraryTagCreateIn,
        _: Annotated[Principal, require_permission("users:manage")],
    ) -> LibraryTagOut:
        """加一个维度或取值，答复新的节点。已有的条目不跟着重打。"""

        return await service.create(body)

    @router.patch("/{tag_id}", response_model=LibraryTagOut)
    async def update_library_tag(
        tag_id: uuid.UUID,
        body: LibraryTagUpdateIn,
        _: Annotated[Principal, require_permission("users:manage")],
    ) -> LibraryTagOut:
        """改名、判断说明、AI 打标或同级里的先后，答复改完的节点。已打的标签不跟着重打。"""

        return await service.update(tag_id, body)

    @router.delete("/{tag_id}", status_code=204)
    async def delete_library_tag(
        tag_id: uuid.UUID,
        _: Annotated[Principal, require_permission("users:manage")],
    ) -> Response:
        """删掉一个标签连同它的下级，两库条目上的这些标签一起去掉。"""

        await service.delete(tag_id)
        return Response(status_code=204)

    return router


__all__ = ["create_tagging_router"]
