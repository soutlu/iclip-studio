"""「谁在用」：被 agent 配置引用的技能、模型、密钥与 agent 交回的引用方，接口里的 ``usedBy`` 形状，以及拦下
操作时的那句话。

技能库、模型供应商与 agent 配置三处共用这一份。规则：某个 agent 的草稿或当前版本还在引用就算在用，只被旧版本
用到的不算。"""

from __future__ import annotations

import uuid
from collections.abc import Iterable
from dataclasses import dataclass

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


@dataclass(frozen=True, slots=True)
class AgentUsage:
    """一个在用的 agent：草稿里引用了、当前版本里引用了，至少有一个为真。"""

    agent_id: str
    agent_name: str
    in_draft: bool
    in_active_version: bool


@dataclass(frozen=True, slots=True)
class ModelReference:
    """一个 agent 的草稿或当前版本里写的模型：供应商引用名、模型名与显式写的密钥（没写为 ``None``）。"""

    provider: str
    model: str
    credential_id: uuid.UUID | None
    usage: AgentUsage


def merge_usages(usages: Iterable[AgentUsage]) -> tuple[AgentUsage, ...]:
    """同一个 agent 的几条合成一条（两处标记取「或」），按 agent 标识排。"""

    merged: dict[str, AgentUsage] = {}
    for one in usages:
        found = merged.get(one.agent_id)
        merged[one.agent_id] = (
            one
            if found is None
            else AgentUsage(
                agent_id=one.agent_id,
                agent_name=one.agent_name,
                in_draft=found.in_draft or one.in_draft,
                in_active_version=found.in_active_version or one.in_active_version,
            )
        )
    return tuple(merged[key] for key in sorted(merged))


def in_use_message(what: str, usages: Iterable[AgentUsage]) -> str:
    """拦下操作时给人看的一句话，列出在用的 agent 与在哪儿用。"""

    listed = "、".join(
        f"{one.agent_name}（{one.agent_id}，{_where(one)}）" for one in merge_usages(usages)
    )
    return f"{what}还在被这些 agent 使用：{listed}；先在它们的草稿与当前版本里去掉再操作"


def _where(usage: AgentUsage) -> str:
    if usage.in_draft and usage.in_active_version:
        return "草稿与当前版本"
    return "草稿" if usage.in_draft else "当前版本"


class AgentUsageOut(BaseModel):
    """接口里 ``usedBy`` 的一项：一个在用的 agent，草稿或当前版本里引用了。"""

    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True
    )

    agent_id: str
    agent_name: str
    in_draft: bool
    in_active_version: bool


def usages_out(usages: Iterable[AgentUsage]) -> list[AgentUsageOut]:
    """合并同一 agent 的几条后按 agent 标识排好的 ``usedBy``。"""

    return [
        AgentUsageOut(
            agent_id=one.agent_id,
            agent_name=one.agent_name,
            in_draft=one.in_draft,
            in_active_version=one.in_active_version,
        )
        for one in merge_usages(usages)
    ]


__all__ = [
    "AgentUsage",
    "AgentUsageOut",
    "ModelReference",
    "in_use_message",
    "merge_usages",
    "usages_out",
]
