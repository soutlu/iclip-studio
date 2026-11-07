from __future__ import annotations

from cue.config.skills.schemas import SkillDetailOut as RuntimeSkillDetailOut
from cue.config.skills.schemas import SkillOut as RuntimeSkillOut
from cue.config.skills.schemas import (
    SkillVersionDetailOut as RuntimeSkillVersionDetailOut,
)
from cue.config.skills.schemas import SkillVersionOut as RuntimeSkillVersionOut

from iclip.platform.runtime_admin import AdminOut, CreatedByName


class SkillOut(RuntimeSkillOut, CreatedByName):
    pass


class SkillsOut(AdminOut):
    items: list[SkillOut]


class SkillDetailOut(RuntimeSkillDetailOut, CreatedByName):
    pass


class SkillVersionOut(RuntimeSkillVersionOut, CreatedByName):
    pass


class SkillVersionsOut(AdminOut):
    items: list[SkillVersionOut]


class SkillVersionDetailOut(RuntimeSkillVersionDetailOut, CreatedByName):
    pass


__all__ = [
    "SkillDetailOut",
    "SkillOut",
    "SkillVersionDetailOut",
    "SkillVersionOut",
    "SkillVersionsOut",
    "SkillsOut",
]
