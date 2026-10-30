"""会话工作区与素材台账接口：列文件、读一份、带版本写一份；登记素材、按地址查一条。

命名空间是「``X-End-User``（会话属主）/会话 id」，与 agent 的工作区插件、受理消息时登记附件同一条规则。
报错同后端读写工作区文件的端点：路径或内容不合规 422，版本对不上 409，文件不在 404。这一层不发文件
变更通知。
"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Query

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
from agent_runtime.http.auth import SessionOwner
from agent_runtime.material_ledger.store import Material, MaterialLedger
from agent_runtime.transcript.wire import Envelope


class FilesOut(Envelope):
    files: tuple[FileEntry, ...]


class FileWriteIn(Envelope):
    """整份覆盖一份文件。``expected_version`` 给了就按它比对：对不上（含文件已删）是 409；不给照写。"""

    content: str
    expected_version: int | None = None


class MaterialsIn(Envelope):
    materials: tuple[Material, ...]
    """同一地址重复登记保留首条。"""


def _namespace(owner: uuid.UUID, session_id: uuid.UUID) -> str:
    return namespace_for(owner, str(session_id))


def create_workspace_router(files: FileStore, ledger: MaterialLedger) -> APIRouter:
    router = APIRouter(prefix="/sessions/{session_id}", tags=["workspace"])

    @router.get("/files", response_model=FilesOut)
    async def list_files(
        session_id: uuid.UUID,
        owner: SessionOwner,
        prefix: Annotated[
            str,
            Query(description="只列这条路径本身与它下面的文件（按目录段匹配）；不给列全部。"),
        ] = "",
    ) -> FilesOut:
        try:
            entries = await files.entries(_namespace(owner, session_id), prefix=prefix)
        except InvalidPath as exc:
            raise ValidationFailed(str(exc)) from exc
        return FilesOut(files=tuple(entries))

    @router.get("/files/{path:path}", response_model=StoredFile)
    async def read_file(session_id: uuid.UUID, path: str, owner: SessionOwner) -> StoredFile:
        try:
            found = await files.read(_namespace(owner, session_id), path)
        except InvalidPath as exc:
            raise ValidationFailed(str(exc)) from exc
        if found is None:
            raise NotFound("这段对话里没有这个文件")
        return found

    @router.put("/files/{path:path}", response_model=FileEntry)
    async def write_file(
        session_id: uuid.UUID, path: str, body: FileWriteIn, owner: SessionOwner
    ) -> FileEntry:
        """整份覆盖。只收规范路径：应用按原始路径挑的文档校验，不能被存储层归一化后的路径绕过。"""

        try:
            if normalize_path(path) != path:
                raise ValidationFailed(f"路径 {path!r} 不是规范形式，按工作区文件列表里的写法给")
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
        session_id: uuid.UUID, body: MaterialsIn, owner: SessionOwner
    ) -> None:
        await ledger.record(_namespace(owner, session_id), body.materials)

    @router.get("/materials", response_model=Material)
    async def lookup_material(
        session_id: uuid.UUID,
        owner: SessionOwner,
        url: Annotated[str, Query(min_length=1, description="素材地址，按原始字符串精确匹配。")],
    ) -> Material:
        found = await ledger.lookup(_namespace(owner, session_id), url)
        if found is None:
            raise NotFound("这段对话的素材里没有这个地址")
        return found

    return router


__all__ = ["FileWriteIn", "FilesOut", "MaterialsIn", "create_workspace_router"]
