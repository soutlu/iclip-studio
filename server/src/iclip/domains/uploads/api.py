from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Query

from iclip.domains.identity.public import ActAs, Principal, require_permission
from iclip.domains.uploads.models import MediaKind
from iclip.domains.uploads.schemas import (
    UploadConfirmIn,
    UploadOut,
    UploadSignIn,
    UploadsPageOut,
    upload_out,
)
from iclip.domains.uploads.service import UploadService
from iclip.platform.object_store.direct_upload import UploadTicketOut
from iclip.platform.paging import DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT


def create_uploads_router(service: UploadService, *, act_as: ActAs) -> APIRouter:
    router = APIRouter(tags=["uploads"])

    @router.get("/conversations/{conversation_id}/uploads", response_model=UploadsPageOut)
    async def list_conversation_uploads(
        conversation_id: uuid.UUID,
        principal: Annotated[Principal, require_permission("generation:read")],
        limit: Annotated[int, Query(ge=1, le=MAX_LIST_LIMIT)] = DEFAULT_LIST_LIMIT,
        kind: MediaKind | None = None,
        before: uuid.UUID | None = None,
    ) -> UploadsPageOut:
        """挂在这段对话上的上传，新的在前；含经分叉继承来的（祖先对话在分叉时刻以前挂上的）。

        读不到这段对话 ``404``。``kind`` 按种类筛。用上一页最后一条的 ``id`` 作 ``before`` 往后翻，
        ``before`` 指的上传不存在也是 ``404``。
        """

        uploads = await service.conversation_uploads(
            principal, conversation_id, limit=limit, kind=kind, before=before
        )
        return UploadsPageOut(items=[upload_out(upload) for upload in uploads])

    @router.post("/uploads/sign", response_model=UploadTicketOut)
    async def sign_upload(
        body: UploadSignIn,
        principal: Annotated[Principal, require_permission("uploads:write")],
    ) -> UploadTicketOut:
        """发一条限时直传地址；上传者与 key 一起签进请求头，随对象存进桶。"""

        return UploadTicketOut.of(service.sign_upload(principal, body))

    @router.post("/uploads/{upload_id}/confirm", response_model=UploadOut)
    async def confirm_upload(
        upload_id: uuid.UUID,
        principal: Annotated[Principal, require_permission("uploads:write")],
        body: UploadConfirmIn | None = None,
    ) -> UploadOut:
        """按桶里的对象核对类型与大小，通过后记进上传台账（id 就是 ``uploadId``）：大小、内容类型与
        MD5 取对象存储报的，时长不量。同一个视频文件已经传过，交回最早那份的地址。

        请求体可选。``userName`` 给了按替人办事换主体（浏览器只能写自己），不给就记在当前主体名下。
        ``conversationId`` 把这次上传挂到那段对话（任何种类都行）：对话看不见 404，不是属主或已删除
        403。``width`` / ``height`` 是图片签名时报的宽高，两个都给才记，越界 422；别的种类不记。
        可重复调：记过就原样交回那一条，第二次的请求体都不改记录。
        """

        principal = await act_as(principal, body.user_name if body is not None else None)
        given = body or UploadConfirmIn()
        confirmed = await service.confirm(
            principal,
            upload_id,
            conversation_id=given.conversation_id,
            width=given.width,
            height=given.height,
        )
        return upload_out(confirmed)

    return router


__all__ = ["create_uploads_router"]
