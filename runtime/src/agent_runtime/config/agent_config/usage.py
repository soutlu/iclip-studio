from __future__ import annotations

import uuid
from collections.abc import Sequence

from agent_runtime.agent_usage import AgentUsage, ModelReference, merge_usages
from agent_runtime.config.agent_config.models import AgentRefs, ConfigRefs
from agent_runtime.config.agent_config.repository import AgentStore


def _usage(refs: AgentRefs, *, in_draft: bool, in_active: bool) -> AgentUsage | None:
    if not (in_draft or in_active):
        return None
    return AgentUsage(
        agent_id=refs.agent_id,
        agent_name=refs.name,
        in_draft=in_draft,
        in_active_version=in_active,
    )


def subagent_users(agents: Sequence[AgentRefs], agent_id: str) -> tuple[AgentUsage, ...]:
    found = (
        _usage(
            refs,
            in_draft=agent_id in refs.draft.subagents,
            in_active=refs.active is not None and agent_id in refs.active.subagents,
        )
        for refs in agents
        if refs.agent_id != agent_id
    )
    return tuple(one for one in found if one is not None)


def skill_users(agents: Sequence[AgentRefs], skill_id: uuid.UUID) -> tuple[AgentUsage, ...]:
    found = (
        _usage(
            refs,
            in_draft=skill_id in refs.draft.skill_ids,
            in_active=refs.active is not None and skill_id in refs.active.skill_ids,
        )
        for refs in agents
    )
    return tuple(one for one in found if one is not None)


def mcp_server_users(agents: Sequence[AgentRefs]) -> dict[str, tuple[AgentUsage, ...]]:
    found: dict[str, list[AgentUsage]] = {}
    for refs in agents:
        active = refs.active.mcp_servers if refs.active is not None else ()
        for server_id in {*refs.draft.mcp_servers, *active}:
            usage = _usage(
                refs, in_draft=server_id in refs.draft.mcp_servers, in_active=server_id in active
            )
            if usage is not None:
                found.setdefault(server_id, []).append(usage)
    return {server_id: merge_usages(usages) for server_id, usages in found.items()}


def model_references(agents: Sequence[AgentRefs]) -> tuple[ModelReference, ...]:
    references: list[ModelReference] = []
    for refs in agents:
        for config, in_draft in ((refs.draft, True), (refs.active, False)):
            reference = _model_reference(refs, config, in_draft=in_draft)
            if reference is not None:
                references.append(reference)
    return tuple(references)


def _model_reference(
    refs: AgentRefs, config: ConfigRefs | None, *, in_draft: bool
) -> ModelReference | None:
    if config is None or config.provider is None or config.model is None:
        return None
    return ModelReference(
        provider=config.provider,
        model=config.model,
        credential_id=config.credential_id,
        usage=AgentUsage(
            agent_id=refs.agent_id,
            agent_name=refs.name,
            in_draft=in_draft,
            in_active_version=not in_draft,
        ),
    )


class AgentReferences:
    def __init__(self, store: AgentStore) -> None:
        self._store = store

    async def skill_users(self, skill_id: uuid.UUID) -> tuple[AgentUsage, ...]:
        return skill_users(await self._store.references(), skill_id)

    async def model_references(self) -> tuple[ModelReference, ...]:
        return model_references(await self._store.references())

    async def mcp_server_users(self) -> dict[str, tuple[AgentUsage, ...]]:
        return mcp_server_users(await self._store.references())


__all__ = [
    "AgentReferences",
    "mcp_server_users",
    "model_references",
    "skill_users",
    "subagent_users",
]
