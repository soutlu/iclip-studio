"""skills 装配单元：组合根只调用 ``build_skills_module``。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from iclip.domains.skills.api import create_skills_router
from iclip.domains.skills.repository import SkillStore, SkillUsages
from iclip.domains.skills.service import SkillsService


@dataclass(frozen=True)
class SkillsModule:
    routers: tuple[Any, ...]
    """使用 Any 隔离 Web 框架类型。"""

    service: SkillsService


def build_skills_module(store: SkillStore, *, usages: SkillUsages) -> SkillsModule:
    """``usages`` 由组合根接到 agent 配置域。"""

    service = SkillsService(store, usages=usages)
    return SkillsModule(routers=(create_skills_router(service),), service=service)


__all__ = ["SkillsModule", "build_skills_module"]
