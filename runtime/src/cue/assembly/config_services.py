from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncEngine

from cue.assembly.directories import (
    LibrarySkillDirectory,
    McpServerDirectory,
    ProviderDirectory,
    RegistryPluginDirectory,
)
from cue.assembly.mcp import HarnessMcpProbe
from cue.assembly.models import PydanticAiCredentialProbe, require_known_providers
from cue.config.agent_config.public import (
    AgentConfigService,
    AgentReferences,
    SqlAgentStore,
)
from cue.config.mcp_servers.public import (
    McpServerIndex,
    McpServerService,
    SqlMcpServerStore,
)
from cue.config.model_providers.public import (
    CredentialProbe,
    ModelProviderService,
    SqlModelProviderStore,
    load_declarations,
)
from cue.config.skills.public import SkillsService, SqlSkillStore
from cue.plugins.base import PluginRegistry
from cue.secrets import CredentialCipher


@dataclass(frozen=True, slots=True)
class ConfigServices:
    skills: SkillsService
    model_providers: ModelProviderService
    mcp_servers: McpServerService
    mcp_index: McpServerIndex
    agent_config: AgentConfigService


def build_config_services(
    engine: AsyncEngine,
    *,
    credential_keys: Sequence[str],
    plugins: PluginRegistry,
    probe: CredentialProbe | None = None,
) -> ConfigServices:
    agent_store = SqlAgentStore(engine)
    references = AgentReferences(agent_store)
    cipher = CredentialCipher(credential_keys)
    skills = SkillsService(SqlSkillStore(engine), usages=references)
    declarations = load_declarations()
    require_known_providers(declarations)
    model_providers = ModelProviderService(
        SqlModelProviderStore(engine),
        declarations=declarations,
        cipher=cipher,
        probe=probe if probe is not None else PydanticAiCredentialProbe(),
        usages=references,
    )
    mcp_index = McpServerIndex()
    mcp_servers = McpServerService(
        SqlMcpServerStore(engine),
        cipher=cipher,
        probe=HarnessMcpProbe(),
        usages=references,
        index=mcp_index,
    )
    agent_config = AgentConfigService(
        agent_store,
        models=ProviderDirectory(model_providers),
        plugins=RegistryPluginDirectory(plugins),
        mcp=McpServerDirectory(mcp_servers),
        skills=LibrarySkillDirectory(skills),
    )
    return ConfigServices(
        skills=skills,
        model_providers=model_providers,
        mcp_servers=mcp_servers,
        mcp_index=mcp_index,
        agent_config=agent_config,
    )


__all__ = ["ConfigServices", "build_config_services"]
