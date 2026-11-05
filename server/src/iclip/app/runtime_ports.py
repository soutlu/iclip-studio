from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence

from agent_runtime.app_wire import (
    ActivitiesIn,
    FilesCopyIn,
    PreviewTargetIn,
    SessionForkIn,
    SessionOpenIn,
    TitleIn,
)
from agent_runtime.client import RuntimeClient
from agent_runtime.transcript.wire import SessionActivityOut

from iclip.domains.conversations.service import AgentDirectory, AgentEntry


class RuntimeServicePorts:
    def __init__(self, client: RuntimeClient) -> None:
        self._client = client

    async def open(self, session_id: uuid.UUID, *, agent_id: str) -> None:
        await self._client.open_session(SessionOpenIn(id=session_id, agent_id=agent_id))

    async def abort(self, session_id: uuid.UUID) -> None:
        await self._client.abort_session(session_id)

    async def open_preview(
        self, session_id: uuid.UUID, *, agent_id: str, version_id: uuid.UUID | None
    ) -> None:
        await self._client.open_session(
            SessionOpenIn(
                id=session_id, preview=PreviewTargetIn(agent_id=agent_id, version_id=version_id)
            )
        )

    async def fork(
        self,
        *,
        source_id: uuid.UUID,
        source_user: uuid.UUID,
        target_id: uuid.UUID,
        target_user: uuid.UUID,
        turn: int,
        agent_id: str | None,
    ) -> None:
        await self._client.fork_session(
            source_id,
            SessionForkIn(
                target_id=target_id, source_user=source_user, turn=turn, agent_id=agent_id
            ),
            owner=target_user,
        )

    async def copy_files(
        self,
        *,
        source_id: uuid.UUID,
        source_user: uuid.UUID,
        target_id: uuid.UUID,
        target_user: uuid.UUID,
        files: Sequence[tuple[str, str]],
        require_any: frozenset[str],
    ) -> bool:
        copied = await self._client.copy_files(
            source_id,
            FilesCopyIn(
                target_id=target_id,
                source_user=source_user,
                files=tuple(files),
                require_any=tuple(sorted(require_any)),
            ),
            owner=target_user,
        )
        return copied.copied

    async def list_agents(self) -> AgentDirectory:
        found = await self._client.agents()
        return AgentDirectory(
            items=tuple(AgentEntry(id=item.id, name=item.name) for item in found.items),
            default=found.default,
        )

    async def generate_title(self, user_text: str) -> str | None:
        return (await self._client.generate_title(TitleIn(text=user_text))).title

    async def activities(
        self, conversation_ids: Sequence[uuid.UUID]
    ) -> Mapping[uuid.UUID, SessionActivityOut]:
        if not conversation_ids:
            return {}
        found = await self._client.activities(ActivitiesIn(ids=tuple(conversation_ids)))
        return found.items

    async def busy(self, owner: uuid.UUID | None) -> frozenset[uuid.UUID]:
        return frozenset((await self._client.busy(owner=owner)).ids)


__all__ = ["RuntimeServicePorts"]
