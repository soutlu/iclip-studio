from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from agent_runtime.client import RuntimeClient

from iclip.domains.agent_config.api import create_agent_config_router
from iclip.platform.runtime_admin import UserNames


@dataclass(frozen=True)
class AgentConfigModule:
    routers: tuple[Any, ...]


def build_agent_config_module(runtime: RuntimeClient, user_names: UserNames) -> AgentConfigModule:
    return AgentConfigModule(routers=(create_agent_config_router(runtime, user_names),))


__all__ = ["AgentConfigModule", "build_agent_config_module"]
