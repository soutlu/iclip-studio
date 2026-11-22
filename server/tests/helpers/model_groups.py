from __future__ import annotations

import uuid
from collections.abc import Iterable, Mapping, Sequence
from typing import Final

from sqlalchemy import text

from iclip.config import ModelGroupSection, RuntimeConfig
from iclip.domains.generation.model_groups import ModelGroup, ModelGroups
from tests.helpers.pg import connected

MKT: Final = "mkt"

DEFAULT: Final = "default"


class GroupBook:
    """按用户 id 查配置组的替身：没登记的人是默认组。"""

    def __init__(self, groups: Mapping[uuid.UUID, str] | None = None) -> None:
        self.groups = dict(groups or {})

    async def __call__(self, user_id: uuid.UUID, /) -> str | None:
        return self.groups.get(user_id)


def default_only(
    models: Iterable[str] = (),
    *,
    video_api_key: str = "vk-test",
    subtitle_api_key: str | None = None,
    music_api_key: str | None = None,
    speech_api_key: str | None = None,
) -> ModelGroups:
    """只有 ``default`` 组、人人都在默认组的 ``ModelGroups``；``models`` 里的产品模型名原样作该组的
    model_id。"""

    return ModelGroups(
        ModelGroup(
            name=DEFAULT,
            video_api_key=video_api_key,
            video_models={model: model for model in models},
            subtitle_api_key=subtitle_api_key,
            music_api_key=music_api_key,
            speech_api_key=speech_api_key,
        ),
        group_of=GroupBook(),
    )


def with_model_groups(config: RuntimeConfig, names: Sequence[str]) -> RuntimeConfig:
    """给配置添上 ``model_groups``，按 ``names`` 的先后、接在已有的组后面；没开媒体生成时不查 key。"""

    return config.model_copy(
        update={
            "model_groups": {
                **(config.model_groups or {}),
                **{
                    name: ModelGroupSection(
                        video_api_key_env=f"VIDEO_API_KEY_{name.upper()}", video_models={}
                    )
                    for name in names
                },
            }
        }
    )


async def set_model_group_in_db(pg_url: str, user_id: str, group: str | None) -> None:
    """直接改库里用户的组；接口不收配置里没有的组名，测组失效时只能这样写。"""

    async with connected(pg_url) as conn:
        await conn.execute(
            text("UPDATE iclip.users SET model_group = :group WHERE id = :id"),
            {"group": group, "id": uuid.UUID(user_id)},
        )


__all__ = [
    "MKT",
    "GroupBook",
    "default_only",
    "set_model_group_in_db",
    "with_model_groups",
]
