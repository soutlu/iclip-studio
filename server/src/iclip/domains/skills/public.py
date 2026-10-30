"""skills 的跨模块契约：其它模块只准从这里 import。"""

from __future__ import annotations

from iclip.domains.skills.models import STATUS_ARCHIVED, Skill
from iclip.domains.skills.repository import SkillUsages
from iclip.domains.skills.service import SkillsService

__all__ = ["STATUS_ARCHIVED", "Skill", "SkillUsages", "SkillsService"]
