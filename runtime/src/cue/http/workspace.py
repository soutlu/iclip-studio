from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable
from typing import Annotated

from fastapi import APIRouter, Depends, Query

from cue.app_wire import FilesOut, FileWriteIn
from cue.errors import Conflict, NotFound, ValidationFailed
from cue.file_store.namespace import namespace_for
from cue.file_store.store import (
    FileEntry,
    FileStore,
    InvalidContent,
    InvalidPath,
    QuotaExceeded,
    StoredFile,
    VersionConflict,
    normalize_path,
)
from cue.http.auth import CallingApp, SessionOwner
from cue.service.sessions import SessionService


def _namespace(owner: uuid.UUID, session_id: uuid.UUID) -> str:
    return namespace_for(owner, str(session_id))


def create_workspace_router(
    files: FileStore,
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

    return router


__all__ = ["create_workspace_router"]
