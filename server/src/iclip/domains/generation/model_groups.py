from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Final

from iclip.domains.generation.models import GenerationJob
from iclip.domains.generation.provider import ProviderError
from iclip.domains.identity.public import ModelGroupOf


@dataclass(frozen=True, slots=True)
class ModelGroup:
    """一个配置组在媒体生成里用的 key 与网关 model_id。

    ``video_models`` 是「产品模型名 → 该组网关 model_id」；字幕、配乐、配音没开通时对应的 key 为
    ``None``。
    """

    name: str
    video_api_key: str
    video_models: Mapping[str, str]
    subtitle_api_key: str | None = None
    music_api_key: str | None = None
    speech_api_key: str | None = None


class ModelGroups:
    """媒体生成按配置组区分 key 与网关 model_id。

    受理时按属主定组（``group_of`` / ``video_model_of``），定下的组名与 model_id 写进生成记录；调用上游时
    只看记录上的组（``of``）。不给任何组即不分组，所有人走默认组。
    """

    def __init__(
        self, groups: Sequence[ModelGroup] = (), *, group_of: ModelGroupOf | None = None
    ) -> None:
        if groups and group_of is None:
            raise RuntimeError("配了配置组却没接「用户 → 组」的查询：受理时定不了组")
        self._groups = {group.name: group for group in groups}
        self._group_of = group_of

    async def group_of(self, owner: uuid.UUID) -> str | None:
        """属主所在配置组的组名，默认组答 ``None``；组已不在配置里时由注入的「用户 → 组」查询抛错。"""
        if self._group_of is None:
            return None
        name = await self._group_of(owner)
        if name is not None and name not in self._groups:
            raise RuntimeError(
                f"配置组 {name} 不在媒体生成的组里：两边应取自同一份 model_groups，组合根接错了"
            )
        return name

    async def video_model_of(self, owner: uuid.UUID, model: str) -> tuple[str | None, str | None]:
        """属主的组名与该组发给视频网关的 model_id；默认组两者都是 ``None``。"""
        name = await self.group_of(owner)
        if name is None:
            return None, None
        upstream = self._groups[name].video_models.get(model)
        if upstream is None:
            raise RuntimeError(f"配置组 {name} 没写 {model} 的 model_id，启动校验应当已拒绝")
        return name, upstream

    def of(self, job: GenerationJob) -> ModelGroup | None:
        """生成记录上的配置组，默认组答 ``None``。

        Raises:
            ProviderError: 记录上的组已不在配置里（不重试）。
        """
        if job.model_group is None:
            return None
        group = self._groups.get(job.model_group)
        if group is None:
            raise ProviderError(
                f"记录上的配置组 {job.model_group} 已不在配置里",
                code="MODEL_GROUP_UNKNOWN",
                retryable=False,
            )
        return group


UNGROUPED: Final = ModelGroups()
"""不分组：所有人走默认组。"""


def group_key(group: ModelGroup, key: str | None, *, what: str) -> str:
    """配置组的某把 key；没配时抛不重试的 ``ProviderError``，说明是哪个组缺了哪把。"""
    if key is None:
        raise ProviderError(
            f"配置组 {group.name} 没配{what}的 key",
            code="MODEL_GROUP_KEY_MISSING",
            retryable=False,
        )
    return key


__all__ = ["UNGROUPED", "ModelGroup", "ModelGroups", "group_key"]
