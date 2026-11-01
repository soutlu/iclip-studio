"""技能库、模型供应商、MCP 服务与 agent 配置四块服务的装配：运行时服务的组合根与一次性切换命令共用这一份。"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncEngine

from agent_runtime.assembly.directories import (
    LibrarySkillDirectory,
    McpServerDirectory,
    ProviderDirectory,
    RegistryPluginDirectory,
)
from agent_runtime.assembly.mcp import HarnessMcpProbe
from agent_runtime.assembly.models import PydanticAiCredentialProbe, require_known_providers
from agent_runtime.config.agent_config.public import (
    AgentConfigService,
    AgentReferences,
    SqlAgentStore,
)
from agent_runtime.config.mcp_servers.public import (
    McpServerIndex,
    McpServerService,
    SqlMcpServerStore,
)
from agent_runtime.config.model_providers.public import (
    CredentialProbe,
    ModelProviderService,
    SqlModelProviderStore,
    load_declarations,
)
from agent_runtime.config.skills.public import SkillsService, SqlSkillStore
from agent_runtime.plugins.base import PluginRegistry
from agent_runtime.secrets import CredentialCipher


@dataclass(frozen=True, slots=True)
class ConfigServices:
    """四块配置的服务，读写同一个库；``mcp_index`` 是 MCP 服务的名册，由 ``mcp_servers`` 维护，给工具卡读。"""

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
    """建四块配置的服务。

    agent 配置与技能库、模型供应商、MCP 服务互相要用：那三边经端口问 agent 表「谁在用」，agent 配置经端口查
    它们。先建 agent 的仓储交给那三边，再用它们的服务装 agent 配置。``plugins`` 是 agent 配置校验插件与列出
    可挂插件时看的登记表；``probe`` 不给就用真实的试连。MCP 服务总是真连。密钥的机密字段与 MCP 服务的
    请求头用同一串加密 key。

    供应商声明里有 pydantic-ai 不认的 provider 时报错（见 ``require_known_providers``）。
    """

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
