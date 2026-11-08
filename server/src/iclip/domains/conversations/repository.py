from __future__ import annotations

import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Final, Literal, Protocol

from iclip.domains.conversations.models import AgentPreview, Conversation, WholeFilmDraft

MISSING_TASK: Final = "没有这张需求单"
MISSING_COLLECTION: Final = "没有这个合集"


@dataclass(frozen=True, slots=True)
class CollectionConversations:
    collection_id: uuid.UUID
    total: int
    conversations: tuple[Conversation, ...]


@dataclass(frozen=True, slots=True)
class PageCursor:
    created_at: datetime
    conversation_id: uuid.UUID


@dataclass(frozen=True, slots=True)
class StateFilter:
    state: Literal["running", "done", "open"]
    busy: frozenset[uuid.UUID]


DeletedFilter = Literal["live", "deleted", "all"]


@dataclass(frozen=True, slots=True)
class AuditFilter:
    owner: uuid.UUID | None = None
    task_id: uuid.UUID | None = None
    since: datetime | None = None
    until: datetime | None = None
    deleted: DeletedFilter = "live"


class ConversationRepository(Protocol):
    async def create_if_absent(self, conversation: Conversation) -> tuple[Conversation, bool]: ...

    async def get(
        self,
        conversation_id: uuid.UUID,
        *,
        owner: uuid.UUID | None,
        include_deleted: bool = False,
    ) -> Conversation: ...

    async def list_for_owner(
        self, *, owner: uuid.UUID, limit: int, title_contains: str | None = None
    ) -> tuple[Conversation, ...]: ...

    async def list_ungrouped(
        self,
        *,
        owner: uuid.UUID,
        limit: int,
        after: PageCursor | None = None,
        state: StateFilter | None = None,
    ) -> tuple[Conversation, ...]: ...

    async def count_ungrouped(
        self, *, owner: uuid.UUID, state: StateFilter | None = None
    ) -> int: ...

    async def list_in_collection(
        self,
        *,
        owner: uuid.UUID,
        collection_id: uuid.UUID,
        limit: int,
        after: PageCursor | None = None,
        state: StateFilter | None = None,
    ) -> tuple[Conversation, ...]: ...

    async def list_by_collections(
        self,
        *,
        owner: uuid.UUID,
        collection_ids: tuple[uuid.UUID, ...],
        per_collection: int,
        state: StateFilter | None = None,
    ) -> tuple[CollectionConversations, ...]: ...

    async def list_for_task(
        self, *, task_id: uuid.UUID, owner: uuid.UUID
    ) -> tuple[Conversation, ...]: ...

    async def list_audit(
        self,
        scope: AuditFilter,
        *,
        state: StateFilter | None = None,
        limit: int,
        after: PageCursor | None = None,
    ) -> tuple[Conversation, ...]: ...

    async def count_audit(self, scope: AuditFilter, *, state: StateFilter | None = None) -> int: ...

    async def apply_generated_title(self, conversation_id: uuid.UUID, *, title: str) -> bool: ...

    async def rename(
        self, conversation_id: uuid.UUID, *, owner: uuid.UUID, title: str
    ) -> Conversation: ...

    async def set_collection(
        self, conversation_id: uuid.UUID, *, owner: uuid.UUID, collection_id: uuid.UUID | None
    ) -> Conversation: ...

    async def set_task(
        self, conversation_id: uuid.UUID, *, owner: uuid.UUID, task_id: uuid.UUID | None
    ) -> Conversation: ...

    async def set_completed(
        self, conversation_id: uuid.UUID, *, owner: uuid.UUID, completed: bool
    ) -> Conversation: ...

    async def delete(self, conversation_id: uuid.UUID, *, owner: uuid.UUID) -> None: ...

    async def touch_run(
        self, conversation_id: uuid.UUID, *, owner: uuid.UUID, agent_id: str, run_id: str
    ) -> Conversation: ...


class WholeFilmDraftStore(Protocol):
    async def get(self, conversation_id: uuid.UUID) -> WholeFilmDraft | None: ...

    async def save(
        self,
        conversation_id: uuid.UUID,
        *,
        document: Mapping[str, Any],
        revision: int,
        updated_by: uuid.UUID,
    ) -> WholeFilmDraft | None: ...


class AgentPreviewStore(Protocol):
    async def current(self, *, owner: uuid.UUID, agent_id: str) -> AgentPreview | None: ...

    async def get(self, preview_id: uuid.UUID) -> AgentPreview | None: ...

    async def replace(
        self,
        preview_id: uuid.UUID,
        *,
        owner: uuid.UUID,
        agent_id: str,
        version_id: uuid.UUID | None,
    ) -> AgentPreview: ...


__all__ = [
    "AgentPreviewStore",
    "CollectionConversations",
    "ConversationRepository",
    "PageCursor",
    "WholeFilmDraftStore",
]
