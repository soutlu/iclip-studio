"""agent_config 的跨模块契约：其它模块只准从这里 import。"""

from __future__ import annotations

from iclip.domains.agent_config.config import AgentConfig, load_config, problems_from_errors
from iclip.domains.agent_config.models import (
    AgentState,
    AgentVersion,
    CompiledAgent,
    CompiledModel,
    CompiledSkill,
    CompiledSubagent,
    ModelFacts,
    PluginFacts,
    Problem,
    ProviderFacts,
    SkillFacts,
)
from iclip.domains.agent_config.repository import ModelDirectory, PluginDirectory, SkillDirectory
from iclip.domains.agent_config.service import AgentConfigService
from iclip.domains.agent_config.usage import AgentReferences

__all__ = [
    "AgentConfig",
    "AgentConfigService",
    "AgentReferences",
    "AgentState",
    "AgentVersion",
    "CompiledAgent",
    "CompiledModel",
    "CompiledSkill",
    "CompiledSubagent",
    "ModelDirectory",
    "ModelFacts",
    "PluginDirectory",
    "PluginFacts",
    "Problem",
    "ProviderFacts",
    "SkillDirectory",
    "SkillFacts",
    "load_config",
    "problems_from_errors",
]
