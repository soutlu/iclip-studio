"""会话工作区与素材台账接口：列文件、读一份、带版本写一份；登记素材、按地址查一条。

命名空间是「``X-End-User``（会话属主）/会话 id」，与 agent 的工作区插件、受理消息时登记附件同一条规则。
报错同后端读写工作区文件的端点：路径或内容不合规 422，版本对不上 409，文件不在 404。写文件经组合根交来的
会通知的存储，写成功就给订着这段会话的对话内容流连接发 ``event.fs.changed``。会话不是调用方应用的（含不存在）也答 404，在请求
形状校验之后、读写之前。
"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable
from typing import Annotated

from fastapi import APIRouter, Depends, Query

from agent_runtime.app_wire import FilesOut, FileWriteIn, MaterialsIn
from agent_runtime.errors import Conflict, NotFound, ValidationFailed
from agent_runtime.file_store.namespace import namespace_for
from agent_runtime.file_store.store import (
    FileEntry,
    FileStore,
    InvalidContent,
    InvalidPath,
    QuotaExceeded,
    StoredFile,
    VersionConflict,
    normalize_path,
)
from agent_runtime.http.auth import CallingApp, SessionOwner
from agent_runtime.material_ledger.store import Material, MaterialLedger
from agent_runtime.service.sessions import SessionService


def _namespace(owner: uuid.UUID, session_id: uuid.UUID) -> str:
    return namespace_for(owner, str(session_id))


def create_workspace_router(
    files: FileStore,
    ledger: MaterialLedger,
    sessions: SessionService,
    calling_app: Callable[..., Awaitable[CallingApp]],
) -> APIRouter:
    router = APIRouter(prefix="/sessions/{session_id}", tags=["workspace"])
    caller = Depends(calling_app)

    @router.get("/files", response_model=FilesOut)
    async def list_files(
        session_id: uuid.UUID,
        owner: SessionOwner,
        prefix: Annotated[
            str,
            Query(description="只列这条路径本身与它下面的文件（按目录段匹配）；不给列全部。"),
        ] = "",
        app: CallingApp = caller,
    ) -> FilesOut:
        await sessions.require_owned(session_id, app_id=app.id)
        try:
            entries = await files.entries(_namespace(owner, session_id), prefix=prefix)
        except InvalidPath as exc:
            raise ValidationFailed(str(exc)) from exc
        return FilesOut(files=tuple(entries))

    @router.get("/files/{path:path}", response_model=StoredFile)
    async def read_file(
        session_id: uuid.UUID, path: str, owner: SessionOwner, app: CallingApp = caller
    ) -> StoredFile:
        await sessions.require_owned(session_id, app_id=app.id)
        try:
            found = await files.read(_namespace(owner, session_id), path)
        except InvalidPath as exc:
            raise ValidationFailed(str(exc)) from exc
        if found is None:
            raise NotFound("这段对话里没有这个文件")
        return found

    @router.put("/files/{path:path}", response_model=FileEntry)
    async def write_file(
        session_id: uuid.UUID,
        path: str,
        body: FileWriteIn,
        owner: SessionOwner,
        app: CallingApp = caller,
    ) -> FileEntry:
        """整份覆盖。只收规范路径：应用按原始路径挑的文档校验，不能被存储层归一化后的路径绕过。"""

        try:
            if normalize_path(path) != path:
                raise ValidationFailed(f"路径 {path!r} 不是规范形式，按工作区文件列表里的写法给")
        except InvalidPath as exc:
            raise ValidationFailed(str(exc)) from exc
        await sessions.require_owned(session_id, app_id=app.id)
        try:
            return await files.write(
                _namespace(owner, session_id),
                path,
                body.content,
                expected_version=body.expected_version,
            )
        except VersionConflict as exc:
            raise Conflict(str(exc)) from exc
        except (InvalidPath, InvalidContent, QuotaExceeded) as exc:
            raise ValidationFailed(str(exc)) from exc

    @router.post("/materials", status_code=204)
    async def record_materials(
        session_id: uuid.UUID, body: MaterialsIn, owner: SessionOwner, app: CallingApp = caller
    ) -> None:
        await sessions.require_owned(session_id, app_id=app.id)
        await ledger.record(_namespace(owner, session_id), body.materials)

    @router.get("/materials", response_model=Material)
    async def lookup_material(
        session_id: uuid.UUID,
        owner: SessionOwner,
        url: Annotated[str, Query(min_length=1, description="素材地址，按原始字符串精确匹配。")],
        app: CallingApp = caller,
    ) -> Material:
        await sessions.require_owned(session_id, app_id=app.id)
        found = await ledger.lookup(_namespace(owner, session_id), url)
        if found is None:
            raise NotFound("这段对话的素材里没有这个地址")
        return found

    return router


__all__ = ["create_workspace_router"]
