from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter

from iclip.domains.identity.public import ActAs, Principal, require_permission
from iclip.domains.uploads.schemas import (
    UploadConfirmedOut,
    UploadConfirmIn,
    UploadSignIn,
    confirmed_out,
)
from iclip.domains.uploads.service import UploadService
from iclip.platform.object_store.direct_upload import UploadTicketOut


def create_uploads_router(service: UploadService, *, act_as: ActAs) -> APIRouter:
    router = APIRouter(prefix="/uploads", tags=["uploads"])

    @router.post("/sign", response_model=UploadTicketOut)
    async def sign_upload(
        body: UploadSignIn,
        principal: Annotated[Principal, require_permission("uploads:write")],
    ) -> UploadTicketOut:
        """发一条限时直传地址；上传者与 key 一起签进请求头，随对象存进桶。"""

        return UploadTicketOut.of(service.sign_upload(principal, body))

    @router.post("/{upload_id}/confirm", response_model=UploadConfirmedOut)
    async def confirm_upload(
        upload_id: uuid.UUID,
        principal: Annotated[Principal, require_permission("uploads:write")],
        body: UploadConfirmIn | None = None,
    ) -> UploadConfirmedOut:
        """按桶里的对象核对类型与大小，通过后记一条上传记录（id 就是 ``uploadId``），交回地址。
        同一个视频文件已经传过，交回最早那份的地址。

        请求体可选。``userName`` 给了按替人办事换主体（浏览器只能写自己），不给就记在当前主体名下。
        ``conversationId`` 把音乐挂到那段对话：别的类型 422，对话看不见 404，不是属主或已删除 403。
        可重复调：记过就交回记录上的地址，返回同一条记录，第二次的 ``userName`` 与
        ``conversationId`` 都不改记录。
        """

        principal = await act_as(principal, body.user_name if body is not None else None)
        confirmed = await service.confirm(
            principal, upload_id, conversation_id=body.conversation_id if body is not None else None
        )
        return confirmed_out(confirmed)

    return router


__all__ = ["create_uploads_router"]
