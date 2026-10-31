"""技能库、模型供应商与 agent 配置三块服务的装配：运行时服务的组合根与一次性切换命令共用这一份。"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncEngine

from agent_runtime.assembly.directories import (
    LibrarySkillDirectory,
    ProviderDirectory,
    RegistryPluginDirectory,
)
from agent_runtime.assembly.models import PydanticAiCredentialProbe, require_known_providers
from agent_runtime.config.agent_config.public import (
    AgentConfigService,
    AgentReferences,
    SqlAgentStore,
)
from agent_runtime.config.model_providers.public import (
    CredentialCipher,
    CredentialProbe,
    ModelProviderService,
    SqlModelProviderStore,
    load_declarations,
)
from agent_runtime.config.skills.public import SkillsService, SqlSkillStore
from agent_runtime.plugins.base import PluginRegistry


@dataclass(frozen=True, slots=True)
class ConfigServices:
    """三块配置的服务，读写同一个库。"""

    skills: SkillsService
    model_providers: ModelProviderService
    agent_config: AgentConfigService


def build_config_services(
    engine: AsyncEngine,
    *,
    credential_keys: Sequence[str],
    plugins: PluginRegistry,
    probe: CredentialProbe | None = None,
) -> ConfigServices:
    """建三块配置的服务。

    agent 配置与技能库、模型供应商互相要用：那两边经端口问 agent 表「谁在用」，agent 配置经端口查它们。
    先建 agent 的仓储交给那两边，再用它们的服务装 agent 配置。``plugins`` 是 agent 配置校验插件与列出可挂插件
    时看的登记表；``probe`` 不给就用真实的试连。

    供应商声明里有 pydantic-ai 不认的 provider 时报错（见 ``require_known_providers``）。
    """

    agent_store = SqlAgentStore(engine)
    references = AgentReferences(agent_store)
    skills = SkillsService(SqlSkillStore(engine), usages=references)
    declarations = load_declarations()
    require_known_providers(declarations)
    model_providers = ModelProviderService(
        SqlModelProviderStore(engine),
        declarations=declarations,
        cipher=CredentialCipher(credential_keys),
        probe=probe if probe is not None else PydanticAiCredentialProbe(),
        usages=references,
    )
    agent_config = AgentConfigService(
        agent_store,
        models=ProviderDirectory(model_providers),
        plugins=RegistryPluginDirectory(plugins),
        skills=LibrarySkillDirectory(skills),
    )
    return ConfigServices(skills=skills, model_providers=model_providers, agent_config=agent_config)


__all__ = ["ConfigServices", "build_config_services"]
