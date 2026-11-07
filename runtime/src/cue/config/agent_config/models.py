from __future__ import annotations

import re
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Final, Literal

from cue.model_vocab import ThinkingEffort

AgentStatus = Literal["active", "archived"]

STATUS_ACTIVE: Final = "active"
STATUS_ARCHIVED: Final = "archived"

RevisionOperation = Literal["create", "publish", "restore", "import", "archive", "unarchive"]

AGENT_ID_PATTERN: Final = re.compile(r"[a-z][a-z0-9-]{0,39}")

RESERVED_AGENT_IDS: Final = frozenset({"plugins", "order", "import", "model-options"})

MAX_NAME_CHARS: Final = 50
MAX_DESCRIPTION_CHARS: Final = 1024

MCP_TOOL_NAME_PATTERN: Final = re.compile(r"[A-Za-z0-9_-]{1,64}")

_MCP_TOOL_PREFIX: Final = "mcp_"


def mcp_tool_prefix(server_id: str) -> str:
    return f"{_MCP_TOOL_PREFIX}{server_id}"


def mcp_tool_name(server_id: str, tool: str) -> str:
    return f"{mcp_tool_prefix(server_id)}_{tool}"


def split_mcp_tool_name(name: str) -> tuple[str, str] | None:
    if not name.startswith(_MCP_TOOL_PREFIX):
        return None
    server_id, separator, tool = name.removeprefix(_MCP_TOOL_PREFIX).partition("_")
    if not separator or not server_id or not tool:
        return None
    return server_id, tool


@dataclass(frozen=True, slots=True)
class Agent:
    id: str
    name: str
    description: str
    status: AgentStatus
    listed: bool
    sort_order: int
    active_version_id: uuid.UUID | None
    active_version: int | None
    active_published_at: datetime | None
    created_by: uuid.UUID
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class AgentDraft:
    agent_id: str
    config: Mapping[str, Any]
    skill_ids: tuple[uuid.UUID, ...]
    base_version_id: uuid.UUID | None
    lock_version: int
    updated_by: uuid.UUID
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class AgentVersion:
    id: uuid.UUID
    agent_id: str
    version: int
    config: Mapping[str, Any]
    skill_ids: tuple[uuid.UUID, ...]
    note: str | None
    created_by: uuid.UUID
    created_at: datetime


@dataclass(frozen=True, slots=True)
class AgentState:
    agent: Agent
    draft: AgentDraft
    active: AgentVersion | None

    @property
    def has_unpublished_changes(self) -> bool:
        return self.active is None or (self.draft.config, self.draft.skill_ids) != (
            self.active.config,
            self.active.skill_ids,
        )


@dataclass(frozen=True, slots=True)
class ConfigRefs:
    provider: str | None
    model: str | None
    credential_id: uuid.UUID | None
    skill_ids: tuple[uuid.UUID, ...]
    subagents: tuple[str, ...]
    mcp_servers: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class AgentRefs:
    agent_id: str
    name: str
    description: str
    status: AgentStatus
    active_version_id: uuid.UUID | None
    draft: ConfigRefs
    active: ConfigRefs | None

    @property
    def subagents(self) -> frozenset[str]:
        active = self.active.subagents if self.active is not None else ()
        return frozenset((*self.draft.subagents, *active))


@dataclass(frozen=True, slots=True)
class Problem:
    path: str
    message: str


@dataclass(frozen=True, slots=True)
class CompiledModel:
    provider_id: uuid.UUID
    provider: str
    model: str
    credential_id: uuid.UUID
    thinking: ThinkingEffort | None


@dataclass(frozen=True, slots=True)
class CompiledSkill:
    skill_id: uuid.UUID
    name: str
    version_id: uuid.UUID


@dataclass(frozen=True, slots=True)
class CompiledSubagent:
    agent_id: str
    description: str
    version_id: uuid.UUID
    timeout_seconds: float | None
    max_calls: int | None
    on_failure: str | None


@dataclass(frozen=True, slots=True)
class CompiledMcpServer:
    server_id: str
    tools: tuple[str, ...] | None
    tool_prefix: str


@dataclass(frozen=True, slots=True)
class CompiledAgent:
    agent_id: str
    instructions: str
    model: CompiledModel
    capabilities: tuple[Mapping[str, Mapping[str, Any]], ...]
    mcp_servers: tuple[CompiledMcpServer, ...]
    skills: tuple[CompiledSkill, ...]
    subagents: tuple[CompiledSubagent, ...]


@dataclass(frozen=True, slots=True)
class ModelFacts:
    name: str
    enabled: bool
    thinking: tuple[ThinkingEffort, ...]


@dataclass(frozen=True, slots=True)
class ProviderFacts:
    id: uuid.UUID
    name: str
    enabled: bool
    credential_ids: frozenset[uuid.UUID]
    default_credential_id: uuid.UUID | None
    models: tuple[ModelFacts, ...]


@dataclass(frozen=True, slots=True)
class PluginFacts:
    name: str
    label: str
    description: str
    requires: tuple[str, ...]
    parameters_schema: Mapping[str, Any]


@dataclass(frozen=True, slots=True)
class McpServerFacts:
    id: str
    name: str
    enabled: bool
    tools: tuple[str, ...] | None


@dataclass(frozen=True, slots=True)
class SkillFacts:
    id: uuid.UUID
    name: str
    archived: bool
    latest_version_id: uuid.UUID | None


__all__ = [
    "AGENT_ID_PATTERN",
    "MAX_DESCRIPTION_CHARS",
    "MAX_NAME_CHARS",
    "MCP_TOOL_NAME_PATTERN",
    "RESERVED_AGENT_IDS",
    "STATUS_ACTIVE",
    "STATUS_ARCHIVED",
    "Agent",
    "AgentDraft",
    "AgentRefs",
    "AgentState",
    "AgentStatus",
    "AgentVersion",
    "CompiledAgent",
    "CompiledMcpServer",
    "CompiledModel",
    "CompiledSkill",
    "CompiledSubagent",
    "ConfigRefs",
    "McpServerFacts",
    "ModelFacts",
    "PluginFacts",
    "Problem",
    "ProviderFacts",
    "RevisionOperation",
    "SkillFacts",
    "mcp_tool_name",
    "mcp_tool_prefix",
    "split_mcp_tool_name",
]
