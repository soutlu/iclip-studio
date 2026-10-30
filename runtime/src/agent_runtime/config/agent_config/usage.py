"""「谁在用」：按每个 agent 的草稿与当前版本里写的引用，回答某个技能、模型、密钥或 agent 被谁用着。

规则见 ``agent_runtime.agent_usage``：草稿或当前版本还在引用就算在用，只被旧版本用到的不算。技能库与模型供应商
经它们自己声明的端口问这里，由组合根把 ``AgentReferences`` 接过去。"""

from __future__ import annotations

import uuid
from collections.abc import Sequence

from agent_runtime.agent_usage import AgentUsage, ModelReference
from agent_runtime.config.agent_config.models import AgentRefs, ConfigRefs
from agent_runtime.config.agent_config.repository import AgentStore


def _usage(refs: AgentRefs, *, in_draft: bool, in_active: bool) -> AgentUsage | None:
    if not (in_draft or in_active):
        return None
    return AgentUsage(
        agent_id=refs.agent_id,
        agent_name=refs.name,
        in_draft=in_draft,
        in_active_version=in_active,
    )


def subagent_users(agents: Sequence[AgentRefs], agent_id: str) -> tuple[AgentUsage, ...]:
    """把 ``agent_id`` 当作子 agent 的别的 agent。"""

    found = (
        _usage(
            refs,
            in_draft=agent_id in refs.draft.subagents,
            in_active=refs.active is not None and agent_id in refs.active.subagents,
        )
        for refs in agents
        if refs.agent_id != agent_id
    )
    return tuple(one for one in found if one is not None)


def skill_users(agents: Sequence[AgentRefs], skill_id: uuid.UUID) -> tuple[AgentUsage, ...]:
    found = (
        _usage(
            refs,
            in_draft=skill_id in refs.draft.skill_ids,
            in_active=refs.active is not None and skill_id in refs.active.skill_ids,
        )
        for refs in agents
    )
    return tuple(one for one in found if one is not None)


def model_references(agents: Sequence[AgentRefs]) -> tuple[ModelReference, ...]:
    """每个 agent 的草稿与当前版本里写的模型，各一条；没写模型的不列。"""

    references: list[ModelReference] = []
    for refs in agents:
        for config, in_draft in ((refs.draft, True), (refs.active, False)):
            reference = _model_reference(refs, config, in_draft=in_draft)
            if reference is not None:
                references.append(reference)
    return tuple(references)


def _model_reference(
    refs: AgentRefs, config: ConfigRefs | None, *, in_draft: bool
) -> ModelReference | None:
    if config is None or config.provider is None or config.model is None:
        return None
    return ModelReference(
        provider=config.provider,
        model=config.model,
        credential_id=config.credential_id,
        usage=AgentUsage(
            agent_id=refs.agent_id,
            agent_name=refs.name,
            in_draft=in_draft,
            in_active_version=not in_draft,
        ),
    )


class AgentReferences:
    """给技能库与模型供应商回答「谁在用」，每次都按库里当下的草稿与当前版本现算。"""

    def __init__(self, store: AgentStore) -> None:
        self._store = store

    async def skill_users(self, skill_id: uuid.UUID) -> tuple[AgentUsage, ...]:
        return skill_users(await self._store.references(), skill_id)

    async def model_references(self) -> tuple[ModelReference, ...]:
        return model_references(await self._store.references())


__all__ = ["AgentReferences", "model_references", "skill_users", "subagent_users"]
