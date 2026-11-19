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
    """用户所在配置组的组名，默认组答 ``None``；组合根接到 ``ModelGroupAssignments.group_of``。"""

    async def __call__(self, user_id: uuid.UUID, /) -> str | None: ...


class ModelGroupAssignments:
    """谁在哪个配置组：root 给用户选的组名存在用户上，没选即默认组。

    ``configured`` 是部署配置里的组名，按配置里的先后；改组即时生效，不用重启。
    """

    def __init__(self, users: UserRepository, configured: Sequence[str]) -> None:
        self._users = users
        self._configured = tuple(configured)

    async def group_of(self, user_id: uuid.UUID) -> str | None:
        """用户所在配置组的组名，默认组答 ``None``。

        Raises:
            NotFound: 用户不存在。
            ModelGroupUnavailable: 用户存的组已不在部署配置里（不回退默认组）。
        """
        account = await self._users.get(user_id)
        if account is None:
            raise NotFound(f"没有这个用户: {user_id}")
        group = account.model_group
        if group is not None and group not in self._configured:
            _logger.warning("用户所在的配置组已不在部署配置里", user_id=str(user_id), group=group)
            raise ModelGroupUnavailable(f"你所在的配置组 {group} 已不在部署配置里，请联系管理员")
        return group

    async def assign(self, user_id: uuid.UUID, group: str | None) -> UserAccount:
        """把用户放进 ``group``，``None`` 即放回默认组。

        Raises:
            ValidationFailed: 组名不在部署配置里。
            NotFound: 用户不存在。
        """
        if group is not None and group not in self._configured:
            choices = "、".join(self._configured) or "无"
            raise ValidationFailed(
                f"配置组 {group} 不在部署配置的 model_groups 里，可选的组：{choices}"
            )
        updated = await self._users.set_model_group(user_id, group)
        if updated is None:
            raise NotFound("用户不存在")
        return updated


__all__ = ["ModelGroupAssignments", "ModelGroupOf"]
