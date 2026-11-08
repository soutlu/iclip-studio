from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from iclip.domains.skills.api import create_skills_router
from iclip.platform.runtime_admin import UserNames
from iclip.platform.runtime_api.client import RuntimeClient


@dataclass(frozen=True)
class SkillsModule:
    routers: tuple[Any, ...]


def build_skills_module(runtime: RuntimeClient, user_names: UserNames) -> SkillsModule:
    return SkillsModule(routers=(create_skills_router(runtime, user_names),))


__all__ = ["SkillsModule", "build_skills_module"]
