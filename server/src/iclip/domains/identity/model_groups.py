from __future__ import annotations

import uuid
from collections.abc import Sequence
from typing import Protocol

import structlog

from iclip.common.errors import ModelGroupUnavailable, NotFound, ValidationFailed
from iclip.domains.identity.models import UserAccount
from iclip.domains.identity.repository import UserRepository

_logger = structlog.stdlib.get_logger(__name__)


class ModelGroupOf(Protocol):
    """查询用户所属配置组名（默认组返回 ``None``）；由组合根装配至 ``ModelGroupAssignments.group_of``。"""

    async def __call__(self, user_id: uuid.UUID, /) -> str | None: ...


class ModelGroupAssignments:
    """用户与配置组的归属管理：root 分配的组名持久化于用户记录，未分配时归属默认组。

    ``configured`` 为部署配置中可分配的配置组名（不含保留组 ``default``），按配置顺序排列；分配变更即时生效，无需重启服务。
    """

    def __init__(self, users: UserRepository, configured: Sequence[str]) -> None:
        self._users = users
        self._configured = tuple(configured)

    async def group_of(self, user_id: uuid.UUID) -> str | None:
        """返回用户所属配置组名，默认组返回 ``None``。

        Raises:
            NotFound: 用户不存在。
            ModelGroupUnavailable: 用户绑定的配置组已不在部署配置中（不自动回退默认组）。
        """
        account = await self._users.get(user_id)
        if account is None:
            raise NotFound(f"用户不存在: {user_id}")
        group = account.model_group
        if group is not None and group not in self._configured:
            _logger.warning("用户所属配置组已不在部署配置中", user_id=str(user_id), group=group)
            raise ModelGroupUnavailable(
                f"当前账号所属配置组 {group} 已不在部署配置中，请联系管理员重新分配"
            )
        return group

    async def assign(self, user_id: uuid.UUID, group: str | None) -> UserAccount:
        """将用户分配至 ``group``，传入 ``None`` 表示恢复默认组。

        Raises:
            ValidationFailed: 组名不在部署配置中。
            NotFound: 用户不存在。
        """
        if group is not None and group not in self._configured:
            choices = "、".join(self._configured) or "无"
            raise ValidationFailed(
                f"配置组 {group} 不在部署配置的 model_groups 中，可选配置组：{choices}"
            )
        updated = await self._users.set_model_group(user_id, group)
        if updated is None:
            raise NotFound("用户不存在")
        return updated


__all__ = ["ModelGroupAssignments", "ModelGroupOf"]
