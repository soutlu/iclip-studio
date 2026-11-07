from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass
from typing import Any, Protocol

from cue.config.agent_config.models import (
    AgentDraft,
    AgentRefs,
    AgentState,
    AgentStatus,
    AgentVersion,
    McpServerFacts,
    PluginFacts,
    Problem,
    ProviderFacts,
    RevisionOperation,
    SkillFacts,
)


@dataclass(frozen=True, slots=True)
class ImportedAgent:
    agent_id: str
    name: str
    description: str
    listed: bool
    config: Mapping[str, Any]
    skill_ids: tuple[uuid.UUID, ...]


class AgentWriter(Protocol):
    @property
    def state(self) -> AgentState: ...

    async def version(self, version_id: uuid.UUID) -> AgentVersion | None: ...

    async def update(
        self,
        *,
        name: str | None = None,
        description: str | None = None,
        listed: bool | None = None,
        status: AgentStatus | None = None,
    ) -> None: ...

    async def replace_draft(
        self,
        config: Mapping[str, Any],
        skill_ids: Sequence[uuid.UUID],
        *,
        base_version_id: uuid.UUID | None,
        by: uuid.UUID,
    ) -> AgentDraft: ...

    async def publish(
        self,
        version_id: uuid.UUID,
        *,
        config: Mapping[str, Any],
        skill_ids: Sequence[uuid.UUID],
        note: str | None,
        by: uuid.UUID,
    ) -> None: ...

    async def record(
        self,
        operation: RevisionOperation,
        *,
        by: uuid.UUID,
        from_version_id: uuid.UUID | None = None,
        to_version_id: uuid.UUID | None = None,
    ) -> None: ...


class AgentStore(Protocol):
    async def list(self) -> tuple[AgentState, ...]: ...

    async def get(self, agent_id: str) -> AgentState | None: ...

    async def versions(self, agent_id: str) -> tuple[AgentVersion, ...]: ...

    async def version(self, agent_id: str, version_id: uuid.UUID) -> AgentVersion | None: ...

    async def references(self) -> tuple[AgentRefs, ...]: ...

    async def create(
        self,
        agent_id: str,
        *,
        name: str,
        description: str,
        listed: bool,
        config: Mapping[str, Any],
        by: uuid.UUID,
    ) -> None: ...

    async def reorder(self, agent_ids: Sequence[str]) -> None: ...

    async def import_agents(self, agents: Sequence[ImportedAgent], *, by: uuid.UUID) -> None: ...

    def edit(self, agent_id: str) -> AbstractAsyncContextManager[AgentWriter]: ...


class ModelDirectory(Protocol):
    async def provider(self, name: str) -> ProviderFacts | None: ...


class PluginDirectory(Protocol):
    def available(self) -> frozenset[str]: ...

    def requires(self, name: str) -> tuple[str, ...]: ...

    def parameter_problems(
        self, name: str, parameters: Mapping[str, Any]
    ) -> tuple[Problem, ...]: ...

    def catalog(self) -> tuple[PluginFacts, ...]: ...


class McpDirectory(Protocol):
    async def server(self, server_id: str) -> McpServerFacts | None: ...


class SkillDirectory(Protocol):
    async def skills(self) -> tuple[SkillFacts, ...]: ...


__all__ = [
    "AgentStore",
    "AgentWriter",
    "ImportedAgent",
    "McpDirectory",
    "ModelDirectory",
    "PluginDirectory",
    "SkillDirectory",
]
