"""资料库标签 HTTP 端点，约定见合同「标签」一节。"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter

from iclip.domains.identity.public import Principal, require_permission
from iclip.domains.tagging.schemas import LibraryTagsOut
from iclip.domains.tagging.service import TaggingService


def create_tagging_router(service: TaggingService) -> APIRouter:
    router = APIRouter(prefix="/library-tags", tags=["library-tags"])

    @router.get("", response_model=LibraryTagsOut)
    async def library_tags(
        _: Annotated[Principal, require_permission("generation:read")],
    ) -> LibraryTagsOut:
        """整棵标签树，每个标签带灵感库与爆款素材库里各有几条带它或它的下级。"""

        return await service.tree()

    return router


__all__ = ["create_tagging_router"]
