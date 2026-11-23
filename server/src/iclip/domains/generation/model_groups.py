from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from iclip.domains.generation.models import GenerationJob
from iclip.domains.generation.provider import ProviderError
from iclip.domains.identity.public import ModelGroupOf


@dataclass(frozen=True, slots=True)
class ModelGroup:
    """单个配置组在媒体生成中使用的密钥与网关 model_id 映射。

    ``video_models`` 为「产品模型名 → 该组网关 model_id」映射；字幕、配乐或配音未启用时，
    对应密钥为 ``None``。
    """

    name: str
    video_api_key: str
    video_models: Mapping[str, str]
    subtitle_api_key: str | None = None
    music_api_key: str | None = None
    speech_api_key: str | None = None


class ModelGroups:
    """媒体生成按配置组解析对应的密钥与网关 model_id。

    受理阶段按属主确定配置组（``group_of`` / ``video_model_of``）并将组名与网关 model_id 写入生成记录；
    上游调用阶段仅依据记录所绑定的配置组解析（``of``）。``default`` 为未分组用户的默认组，在记录中以
    ``None`` 表示；``named`` 为其余可分配配置组。
    """

    def __init__(
        self,
        default: ModelGroup,
        named: Sequence[ModelGroup] = (),
        *,
        group_of: ModelGroupOf,
    ) -> None:
        self._default = default
        self._groups = {group.name: group for group in named}
        self._group_of = group_of

    async def group_of(self, owner: uuid.UUID) -> str | None:
        """返回属主所属配置组名，默认组返回 ``None``；绑定组已从配置中移除时由注入的查询端口抛错。"""
        name = await self._group_of(owner)
        if name is not None and name not in self._groups:
            raise RuntimeError(
                f"配置组 {name} 未在媒体生成配置组中注册：身份域与生成域须共享同一份 model_groups 配置"
            )
        return name

    async def video_model_of(self, owner: uuid.UUID, model: str) -> tuple[str | None, str]:
        """返回属主的配置组名（默认组为 ``None``）及该组对应的视频网关 model_id。"""
        name = await self.group_of(owner)
        group = self._default if name is None else self._groups[name]
        upstream = group.video_models.get(model)
        if upstream is None:
            raise RuntimeError(
                f"配置组 {group.name} 未配置模型 {model} 的网关 model_id；启动校验应当已拒绝该配置"
            )
        return name, upstream

    def of(self, job: GenerationJob) -> ModelGroup:
        """解析生成记录绑定的配置组；组名为 ``None`` 时返回默认组。

        Raises:
            ProviderError: 记录绑定的配置组已不在部署配置中（不重试）。
        """
        if job.model_group is None:
            return self._default
        group = self._groups.get(job.model_group)
        if group is None:
            raise ProviderError(
                f"生成记录绑定的配置组 {job.model_group} 已不在当前部署配置中",
                code="MODEL_GROUP_UNKNOWN",
                retryable=False,
            )
        return group


def group_key(group: ModelGroup, key: str | None, *, what: str) -> str:
    """获取配置组对应的服务密钥；未配置时抛出不可重试的 ``ProviderError``，指明缺失项所属配置组与能力。"""
    if key is None:
        raise ProviderError(
            f"配置组 {group.name} 未配置{what}密钥",
            code="MODEL_GROUP_KEY_MISSING",
            retryable=False,
        )
    return key


__all__ = ["ModelGroup", "ModelGroups", "group_key"]
