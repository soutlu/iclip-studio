"""对话工作区与素材台账经运行时服务读写：按命名空间寻址的两个适配器，接到运行时会话接口的文件与素材路由上。

命名空间照运行时的规则（``namespace_for(属主, 对话 id)``），这里反解出属主与对话，属主放进 ``X-End-User``。
制作页、工作区文件端点、资料库打标与做同款的判断都经这两个适配器；``iclip_video`` 认对话素材用的
``ConversationImages`` 也按命名空间问素材台账，所以接口照文件存储与素材台账的形状。

写文件经运行时会通知的那份存储，写成功由运行时在应用事件流上发 ``fs.changed``，组合根的事件消费者转给
浏览器。报错是运行时还原出的领域错误：版本对不上 ``Conflict``，路径、内容或容量不合规 ``ValidationFailed``，
原话与运行时进程内的翻译相同；答不上是 ``RuntimeUnavailable``。
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Protocol

from agent_runtime.app_wire import FileWriteIn, MaterialsIn
from agent_runtime.client import RuntimeClient
from agent_runtime.errors import NotFound
from agent_runtime.file_store.namespace import parse_namespace
from agent_runtime.file_store.store import FileEntry, StoredFile
from agent_runtime.material_ledger.store import Material


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


class RuntimeMaterials:
    """素材台账（``MaterialLedger``）经运行时服务的实现。"""

    def __init__(self, client: RuntimeClient) -> None:
        self._client = client

    async def record(self, namespace: str, materials: Sequence[Material]) -> None:
        if not materials:
            return
        owner, conversation_id = parse_namespace(namespace)
        await self._client.record_materials(
            conversation_id, MaterialsIn(materials=tuple(materials)), owner=owner
        )

    async def lookup(self, namespace: str, url: str) -> Material | None:
        owner, conversation_id = parse_namespace(namespace)
        try:
            return await self._client.lookup_material(conversation_id, url, owner=owner)
        except NotFound:
            return None


__all__ = ["RuntimeFiles", "RuntimeMaterials", "WorkspaceFiles"]
