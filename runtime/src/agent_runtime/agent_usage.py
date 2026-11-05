from __future__ import annotations

import uuid
from collections.abc import Iterable
from dataclasses import dataclass

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


@dataclass(frozen=True, slots=True)
class AgentUsage:
    agent_id: str
    agent_name: str
    in_draft: bool
    in_active_version: bool


@dataclass(frozen=True, slots=True)
class ModelReference:
    provider: str
    model: str
    credential_id: uuid.UUID | None
    usage: AgentUsage


def merge_usages(usages: Iterable[AgentUsage]) -> tuple[AgentUsage, ...]:
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
