from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass

from iclip.common.errors import NotFound
from iclip.domains.identity.repository import UserRepository


@dataclass(frozen=True, slots=True)
class DepartmentGroup:
    """一个配置组的归属：组名与它包含的 PMS 部门数字 id。"""

    name: str
    departments: frozenset[int]


class ModelGroupResolver:
    """按用户直属部门找他所在的配置组。

    部门 id 精确匹配，不看上级部门；命中多个组时取 ``groups`` 里排在前面的那个；不命中或没有部门时
    答 ``None``，即默认组。
    """

    def __init__(self, users: UserRepository, groups: Sequence[DepartmentGroup]) -> None:
        self._users = users
        self._groups = tuple(groups)

    async def group_of(self, user_id: uuid.UUID) -> str | None:
        """用户所在配置组的组名，默认组答 ``None``。用户不存在时抛 ``NotFound``。"""
        if not self._groups:
            return None
        account = await self._users.get(user_id)
        if account is None:
            raise NotFound(f"没有这个用户: {user_id}")
        departments = {department.id for department in account.departments}
        for group in self._groups:
            if not departments.isdisjoint(group.departments):
                return group.name
        return None


__all__ = ["DepartmentGroup", "ModelGroupResolver"]
