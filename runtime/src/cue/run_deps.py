from __future__ import annotations

import uuid
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class AgentRunDeps:
    user_id: uuid.UUID
    conversation_id: str
    user_name: str
    preview: bool = False


def conversation_of(deps: object) -> str | None:
    return deps.conversation_id if isinstance(deps, AgentRunDeps) else None


__all__ = ["AgentRunDeps", "conversation_of"]
