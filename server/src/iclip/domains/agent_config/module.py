"""agent_config 装配单元：组合根只调用 ``build_agent_config_module``。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from agent_runtime.client import RuntimeClient

from iclip.domains.agent_config.api import create_agent_config_router


@dataclass(frozen=True)
class AgentConfigModule:
    routers: tuple[Any, ...]
    """使用 Any 隔离 Web 框架类型。"""


def build_agent_config_module(runtime: RuntimeClient) -> AgentConfigModule:
    """端点都转给运行时服务，``runtime`` 是组合根建的那一个客户端。"""

    return AgentConfigModule(routers=(create_agent_config_router(runtime),))


__all__ = ["AgentConfigModule", "build_agent_config_module"]
