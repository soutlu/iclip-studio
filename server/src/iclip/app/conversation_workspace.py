"""对话与工作区的适配：文件读写及文档校验。"""

from __future__ import annotations

import uuid

from agent_runtime.errors import ValidationFailed
from agent_runtime.file_store.namespace import namespace_for
from agent_runtime.file_store.store import InvalidPath, normalize_path
from iclip_video.iclip_studio.film.checks import check_project_content, check_run_content
from iclip_video.shot_document import validate_shots_document

from iclip.app.runtime_workspace import WorkspaceFiles
from iclip.domains.conversations.service import DerivedFile, DerivedFileContent


class ConversationWorkspace:
    """在组合根将属主与对话 id 转换为工作区命名空间，隔离两侧领域知识。写入成功后的文件变更帧由运行时
    在应用事件流上发出。"""

    def __init__(self, store: WorkspaceFiles) -> None:
        self._store = store

    async def list_files(
        self, owner: uuid.UUID, conversation_id: uuid.UUID
    ) -> tuple[DerivedFile, ...]:

        entries = await self._store.entries(namespace_for(owner, str(conversation_id)))
        return tuple(
            DerivedFile(
                path=entry.path,
                size_bytes=entry.size_bytes,
                version=entry.version,
                updated_at=entry.updated_at,
            )
            for entry in entries
        )

    async def read_file(
        self, owner: uuid.UUID, conversation_id: uuid.UUID, path: str
    ) -> DerivedFileContent | None:
        """读取工作区文件，路径格式错误转换为 422。"""

        try:
            stored = await self._store.read(namespace_for(owner, str(conversation_id)), path)
        except InvalidPath as exc:
            raise ValidationFailed(str(exc)) from exc
        if stored is None:
            return None
        return DerivedFileContent(path=stored.path, content=stored.content, version=stored.version)

    async def write_file(
        self,
        owner: uuid.UUID,
        conversation_id: uuid.UUID,
        path: str,
        content: str,
        expected_version: int,
    ) -> DerivedFileContent:
        """按期望版本覆盖文件，冲突返回 409（``Conflict``），路径、内容或容量不合规 422。

        仅接受规范路径，避免存储层归一化后的路径绕过按原始路径匹配的文档校验。"""

        try:
            if normalize_path(path) != path:
                raise ValidationFailed(f"路径 {path!r} 不是规范形式，按工作区文件列表里的写法给")
        except InvalidPath as exc:
            raise ValidationFailed(str(exc)) from exc
        entry = await self._store.write(
            namespace_for(owner, str(conversation_id)),
            path,
            content,
            expected_version=expected_version,
        )
        return DerivedFileContent(path=entry.path, content=content, version=entry.version)


async def validate_video_shots(owner: uuid.UUID, conversation_id: uuid.UUID, content: str) -> None:
    """使用交付工具的同一解析器校验用户写回的镜头组 prompt 表。"""

    _ = (owner, conversation_id)
    try:
        validate_shots_document(content)
    except ValueError as exc:
        raise ValidationFailed(str(exc)) from exc


async def validate_film(owner: uuid.UUID, conversation_id: uuid.UUID, content: str) -> None:
    """用户写回工程文件时，按工具的同一套规则检查这一个文件。

    这里只拿得到这一份内容：要对照运行文件和对话素材的规则留给 ``check_film``。"""

    _ = (owner, conversation_id)
    _reject(check_project_content(content))


async def validate_film_run(owner: uuid.UUID, conversation_id: uuid.UUID, content: str) -> None:
    """用户写回运行文件时检查这一个文件；``use`` 写的节点存不存在留给 ``check_film``。"""

    _ = (owner, conversation_id)
    _reject(check_run_content(content))


def _reject(problems: list[str]) -> None:
    if problems:
        more = f"（共 {len(problems)} 处）" if len(problems) > 1 else ""
        raise ValidationFailed(problems[0] + more)


__all__ = [
    "ConversationWorkspace",
    "validate_film",
    "validate_film_run",
    "validate_video_shots",
]
