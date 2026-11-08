from __future__ import annotations

import uuid

from iclip.platform.runtime_api.file_store.store import normalize_path


def namespace_for(owner: uuid.UUID, conversation_id: str) -> str:
    return normalize_path(f"{owner}/{conversation_id}")


def parse_namespace(namespace: str) -> tuple[uuid.UUID, uuid.UUID]:
    owner, _, conversation_id = namespace.partition("/")
    try:
        return uuid.UUID(owner), uuid.UUID(conversation_id)
    except ValueError as exc:
        raise ValueError(f"{namespace!r} 不是「属主/对话 id」形式的工作区命名空间") from exc


__all__ = ["namespace_for", "parse_namespace"]
