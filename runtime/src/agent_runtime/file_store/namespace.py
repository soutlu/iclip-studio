"""会话命名空间规则：可信属主为外层，会话（对话）id 为内层。

工作区文件与素材台账共用这一条：工作区插件、会话服务、受理消息时登记素材与应用经运行时服务读写，
都由本模块构造与反解，不各写一份。"""

from __future__ import annotations

import uuid

from agent_runtime.file_store.store import normalize_path


def namespace_for(owner: uuid.UUID, conversation_id: str) -> str:
    """由属主与对话 id 构造统一命名空间，按工作区路径规则归一化，与 ``FileSpace.resolve`` 一致。

    对话 id 形状非法时抛 ``InvalidPath``。"""

    return normalize_path(f"{owner}/{conversation_id}")


def parse_namespace(namespace: str) -> tuple[uuid.UUID, uuid.UUID]:
    """``namespace_for`` 的反解，返回属主与对话 id；不是对话命名空间时抛 ``ValueError``。"""

    owner, _, conversation_id = namespace.partition("/")
    try:
        return uuid.UUID(owner), uuid.UUID(conversation_id)
    except ValueError as exc:
        raise ValueError(f"{namespace!r} 不是「属主/对话 id」形式的工作区命名空间") from exc


__all__ = ["namespace_for", "parse_namespace"]
