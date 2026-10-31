"""skills 装配单元：组合根只调用 ``build_skills_module``。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from agent_runtime.client import RuntimeClient

from iclip.domains.skills.api import create_skills_router


@dataclass(frozen=True)
class SkillsModule:
    routers: tuple[Any, ...]
    """使用 Any 隔离 Web 框架类型。"""


def build_skills_module(runtime: RuntimeClient) -> SkillsModule:
    """端点都转给运行时服务，``runtime`` 是组合根建的那一个客户端。"""

    return SkillsModule(routers=(create_skills_router(runtime),))


__all__ = ["SkillsModule", "build_skills_module"]
