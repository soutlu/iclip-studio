"""agent_config 装配单元：组合根只调用 ``build_agent_config_module``。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from iclip.domains.agent_config.api import create_agent_config_router
from iclip.domains.agent_config.repository import (
    AgentStore,
    ModelDirectory,
    PluginDirectory,
    SkillDirectory,
)
from iclip.domains.agent_config.service import AgentConfigService


@dataclass(frozen=True)
class AgentConfigModule:
    routers: tuple[Any, ...]
    """使用 Any 隔离 Web 框架类型。"""

    service: AgentConfigService


def build_agent_config_module(
    store: AgentStore,
    *,
    models: ModelDirectory,
    plugins: PluginDirectory,
    skills: SkillDirectory,
) -> AgentConfigModule:
    service = AgentConfigService(store, models=models, plugins=plugins, skills=skills)
    return AgentConfigModule(routers=(create_agent_config_router(service),), service=service)


__all__ = ["AgentConfigModule", "build_agent_config_module"]
