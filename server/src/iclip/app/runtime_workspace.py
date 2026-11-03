"""对话工作区经运行时服务读写：按命名空间寻址的适配器，接到运行时会话接口的文件路由上。

命名空间照运行时的规则（``namespace_for(属主, 对话 id)``），这里反解出属主与对话，属主放进 ``X-End-User``。
制作页、工作区文件端点、资料库打标与做同款的判断都经这个适配器，所以接口照文件存储的形状。

写文件经运行时会通知的那份存储，写成功由运行时在订着这段对话的对话内容流上发 ``event.fs.changed``，浏览器
连接原样转出。报错是运行时还原出的领域错误：版本对不上 ``Conflict``，路径、内容或容量不合规 ``ValidationFailed``，
原话与运行时进程内的翻译相同；答不上是 ``RuntimeUnavailable``。
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Protocol

from agent_runtime.app_wire import FileWriteIn
from agent_runtime.client import RuntimeClient
from agent_runtime.errors import NotFound
from agent_runtime.file_store.namespace import parse_namespace
from agent_runtime.file_store.store import FileEntry, StoredFile


class WorkspaceFiles(Protocol):
    """对话工作区里读、写、列文件；按命名空间寻址。

    ``read`` 路径不合规抛 ``ValidationFailed``；``write`` 版本对不上抛 ``Conflict``，路径、内容或容量不合规抛
    ``ValidationFailed``。"""

    async def read(self, namespace: str, path: str) -> StoredFile | None: ...

    async def write(
        self, namespace: str, path: str, content: str, *, expected_version: int | None = None
    ) -> FileEntry: ...

    async def entries(self, namespace: str, *, prefix: str = "") -> Sequence[FileEntry]: ...


class RuntimeFiles:
    """``WorkspaceFiles`` 经运行时服务的实现。"""

    def __init__(self, client: RuntimeClient) -> None:
        self._client = client

    async def read(self, namespace: str, path: str) -> StoredFile | None:
        """文件不在为 ``None``；路径不合规 ``ValidationFailed``。"""

        owner, conversation_id = parse_namespace(namespace)
        try:
            return await self._client.read_file(conversation_id, path, owner=owner)
        except NotFound:
            return None

    async def write(
        self, namespace: str, path: str, content: str, *, expected_version: int | None = None
    ) -> FileEntry:
        owner, conversation_id = parse_namespace(namespace)
        return await self._client.write_file(
            conversation_id,
            path,
            FileWriteIn(content=content, expected_version=expected_version),
            owner=owner,
        )

    async def entries(self, namespace: str, *, prefix: str = "") -> Sequence[FileEntry]:
        owner, conversation_id = parse_namespace(namespace)
        return (await self._client.list_files(conversation_id, owner=owner, prefix=prefix)).files


__all__ = ["RuntimeFiles", "WorkspaceFiles"]
