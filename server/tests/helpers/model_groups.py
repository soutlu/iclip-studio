from __future__ import annotations

import json
import uuid
from collections.abc import Mapping, Sequence
from typing import Final

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.config import ModelGroupSection, RuntimeConfig

MKT: Final = "mkt"

MKT_DEPARTMENT: Final = 101


class GroupBook:
    """按用户 id 查配置组的替身：没登记的人是默认组。"""

    def __init__(self, groups: Mapping[uuid.UUID, str] | None = None) -> None:
        self.groups = dict(groups or {})

    async def __call__(self, user_id: uuid.UUID, /) -> str | None:
        return self.groups.get(user_id)


def with_model_groups(config: RuntimeConfig, groups: Mapping[str, Sequence[int]]) -> RuntimeConfig:
    """给配置加上 ``model_groups``，按 ``groups`` 的先后，每组写上它的部门；没开媒体生成时不查 key。"""

    return config.model_copy(
        update={
            "model_groups": {
                name: ModelGroupSection(
                    departments=tuple(departments),
                    video_api_key_env=f"VIDEO_API_KEY_{name.upper()}",
                    video_models={},
                )
                for name, departments in groups.items()
            }
        }
    )


async def set_departments(engine: AsyncEngine, user_id: str, departments: Sequence[int]) -> None:
    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE iclip.users SET departments = CAST(:departments AS jsonb) WHERE id = :id"),
            {"departments": json.dumps([{"id": d} for d in departments]), "id": uuid.UUID(user_id)},
        )


__all__ = ["MKT", "MKT_DEPARTMENT", "GroupBook", "set_departments", "with_model_groups"]
