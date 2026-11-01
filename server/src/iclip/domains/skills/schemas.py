"""技能库端点的答复：运行时的答复模型加上操作人的显示名（见 ``iclip.platform.runtime_admin``）。
运行时只记操作人 id，名字由后端转发时补上；其余字段与运行时的同名模型一致。

带操作人的模型直接继承运行时的；装着它们的列表换了字段类型，按同样的字段另写一份。"""

from __future__ import annotations

from agent_runtime.config.skills.schemas import SkillDetailOut as RuntimeSkillDetailOut
from agent_runtime.config.skills.schemas import SkillOut as RuntimeSkillOut
from agent_runtime.config.skills.schemas import (
    SkillVersionDetailOut as RuntimeSkillVersionDetailOut,
)
from agent_runtime.config.skills.schemas import SkillVersionOut as RuntimeSkillVersionOut

from iclip.platform.runtime_admin import AdminOut, CreatedByName


class SkillOut(RuntimeSkillOut, CreatedByName):
    pass


class SkillsOut(AdminOut):
    items: list[SkillOut]
    """按 ``createdAt`` 倒序。"""


class SkillDetailOut(RuntimeSkillDetailOut, CreatedByName):
    pass


class SkillVersionOut(RuntimeSkillVersionOut, CreatedByName):
    pass


class SkillVersionsOut(AdminOut):
    items: list[SkillVersionOut]
    """版本号从大到小。"""


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
