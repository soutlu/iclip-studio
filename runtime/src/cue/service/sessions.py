from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable, Collection, Sequence
from typing import Final, Protocol

from cue.errors import Conflict, NotFound, ValidationFailed
from cue.file_store.namespace import namespace_for
from cue.file_store.store import FileStore
from cue.harness.jobs import JobQueueView

SESSION_NOT_FOUND: Final = "没有这段会话"

SESSION_ID_TAKEN: Final = "这个会话 id 已经被用了，换一个"

PREVIEW_NOT_FORKABLE: Final = "预览会话不能分叉，也不能拷文件进出"


class SessionStore(Protocol):
    async def open(
        self,
        session_id: uuid.UUID,
        *,
        app_id: str,
        agent_version_id: uuid.UUID | None,
        preview_agent_id: str | None = None,
    ) -> bool: ...

    async def copy(self, source_id: uuid.UUID, target_id: uuid.UUID, *, app_id: str) -> bool: ...

    async def owned(
        self, session_ids: Collection[uuid.UUID], *, app_id: str
    ) -> frozenset[uuid.UUID]: ...

    async def previews(self, session_ids: Collection[uuid.UUID]) -> frozenset[uuid.UUID]: ...


VersionForNewSession = Callable[[str], Awaitable[uuid.UUID]]

CheckPreviewTarget = Callable[[str, uuid.UUID | None], Awaitable[None]]


class SessionQueue(Protocol):
    async def view(self, conversation_id: str) -> JobQueueView: ...


class SeedPlan(Protocol):
    async def commit(self) -> None: ...


class ForkHistory(Protocol):
    async def turn_count(self, conversation_id: str) -> int: ...

    async def plan_fork(
        self, conversation_id: str, *, ordinal: int, target_conversation_id: str
    ) -> SeedPlan | None: ...


class SessionService:
    def __init__(
        self,
        *,
        sessions: SessionStore,
        version_for_new_session: VersionForNewSession,
        check_preview_target: CheckPreviewTarget,
        queue: SessionQueue,
        history: ForkHistory,
        files: FileStore,
    ) -> None:
        self._sessions = sessions
        self._version_for_new_session = version_for_new_session
        self._check_preview_target = check_preview_target
        self._queue = queue
        self._history = history
        self._files = files

    async def owned(
        self, session_ids: Collection[uuid.UUID], *, app_id: str
    ) -> frozenset[uuid.UUID]:
        return await self._sessions.owned(session_ids, app_id=app_id)

    async def require_owned(self, session_id: uuid.UUID, *, app_id: str) -> None:
        if session_id not in await self._sessions.owned((session_id,), app_id=app_id):
            raise NotFound(SESSION_NOT_FOUND)

    async def open(self, session_id: uuid.UUID, *, app_id: str, agent_id: str) -> None:
        version_id = await self._version_for_new_session(agent_id)
        if not await self._sessions.open(session_id, app_id=app_id, agent_version_id=version_id):
            raise Conflict(SESSION_ID_TAKEN)

    async def open_preview(
        self, session_id: uuid.UUID, *, app_id: str, agent_id: str, version_id: uuid.UUID | None
    ) -> None:
        await self._check_preview_target(agent_id, version_id)
        if not await self._sessions.open(
            session_id, app_id=app_id, agent_version_id=version_id, preview_agent_id=agent_id
        ):
            raise Conflict(SESSION_ID_TAKEN)

    async def _refuse_previews(self, *session_ids: uuid.UUID) -> None:
        if await self._sessions.previews(session_ids):
            raise ValidationFailed(PREVIEW_NOT_FORKABLE)

    async def fork(
        self,
        *,
        app_id: str,
        source_id: uuid.UUID,
        source_user: uuid.UUID,
        target_id: uuid.UUID,
        target_user: uuid.UUID,
        turn: int,
        agent_id: str | None,
    ) -> None:
        await self.require_owned(source_id, app_id=app_id)
        await self._refuse_previews(source_id, target_id)
        view = await self._queue.view(str(source_id))
        if view.active is not None or view.queued:
            raise Conflict("这段对话还有没跑完的消息，等它收完尾再分叉")
        turns = await self._history.turn_count(str(source_id))
        if turns == 0:
            raise ValidationFailed("这段对话还没跑过，没有可分叉的轮次")
        if turn > turns:
            raise ValidationFailed(f"这段对话只有 {turns} 轮，分不出第 {turn} 轮")
        seed = await self._history.plan_fork(
            str(source_id), ordinal=turn, target_conversation_id=str(target_id)
        )
        if seed is None:
            raise Conflict("这段对话刚刚又跑了一轮，重新挑一个分叉点")
        if agent_id is None:
            if not await self._sessions.copy(source_id, target_id, app_id=app_id):
                raise Conflict(SESSION_ID_TAKEN)
        else:
            await self.open(target_id, app_id=app_id, agent_id=agent_id)
        source = namespace_for(source_user, str(source_id))
        target = namespace_for(target_user, str(target_id))
        for entry in await self._files.entries(source):
            found = await self._files.read(source, entry.path)
            if found is None:
                raise RuntimeError(f"工作区列出了 {entry.path} 却读不出来，这段对话的文件存坏了")
            await self._files.write(target, entry.path, found.content)
        await seed.commit()

    async def copy_files(
        self,
        *,
        app_id: str,
        source_id: uuid.UUID,
        source_user: uuid.UUID,
        target_id: uuid.UUID,
        target_user: uuid.UUID,
        files: Sequence[tuple[str, str]],
        require_any: frozenset[str],
    ) -> bool:
        await self.require_owned(source_id, app_id=app_id)
        await self.require_owned(target_id, app_id=app_id)
        await self._refuse_previews(source_id, target_id)
        source = namespace_for(source_user, str(source_id))
        found = {path: await self._files.read(source, path) for path, _ in files}
        if require_any and all(found.get(path) is None for path in require_any):
            return False
        target = namespace_for(target_user, str(target_id))
        for path, renamed in files:
            stored = found[path]
            if stored is not None:
                await self._files.write(target, renamed, stored.content)
        return True


__all__ = [
    "PREVIEW_NOT_FORKABLE",
    "SESSION_ID_TAKEN",
    "SESSION_NOT_FOUND",
    "CheckPreviewTarget",
    "ForkHistory",
    "SeedPlan",
    "SessionQueue",
    "SessionService",
    "SessionStore",
    "VersionForNewSession",
]
