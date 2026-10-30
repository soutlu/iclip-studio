"""Agent 配置的端口：自有六张表的仓储，以及由组合根接上的三个查询（模型供应商、插件登记表、技能库）。"""

from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass
from typing import Any, Protocol

from agent_runtime.config.agent_config.models import (
    AgentDraft,
    AgentRefs,
    AgentState,
    AgentStatus,
    AgentVersion,
    PluginFacts,
    Problem,
    ProviderFacts,
    RevisionOperation,
    SkillFacts,
)


@dataclass(frozen=True, slots=True)
class ImportedAgent:
    """正式导入时写的一个 agent：已有就覆盖草稿（名称、描述、``listed`` 不动），没有就新建。"""

    agent_id: str
    name: str
    description: str
    listed: bool
    config: Mapping[str, Any]
    skill_ids: tuple[uuid.UUID, ...]


class AgentWriter(Protocol):
    """一个 agent 的一次修改：开始时锁住它那一行，同一 agent 的修改一个接一个；块正常结束提交、出错回滚。"""

    @property
    def state(self) -> AgentState:
        """锁住时读到的这个 agent。"""
        ...

    async def version(self, version_id: uuid.UUID) -> AgentVersion | None:
        """这个 agent 的这个版本；不属于它给 ``None``。"""
        ...

    async def update(
        self,
        *,
        name: str | None = None,
        description: str | None = None,
        listed: bool | None = None,
        status: AgentStatus | None = None,
    ) -> None:
        """给了的项照写，``None`` 不动。"""
        ...

    async def replace_draft(
        self,
        config: Mapping[str, Any],
        skill_ids: Sequence[uuid.UUID],
        *,
        base_version_id: uuid.UUID | None,
        by: uuid.UUID,
    ) -> AgentDraft:
        """整份换掉草稿的配置与技能绑定，``lock_version`` 加一；交回写完的草稿。"""
        ...

    async def publish(
        self,
        version_id: uuid.UUID,
        *,
        config: Mapping[str, Any],
        skill_ids: Sequence[uuid.UUID],
        note: str | None,
        by: uuid.UUID,
    ) -> None:
        """写一个新版本：版本号取已有最大号加一，连同技能名单与一条 publish 操作记录一起写，移动当前版本
        指针，并把草稿的 ``base_version_id`` 指到它。"""
        ...

    async def record(
        self,
        operation: RevisionOperation,
        *,
        by: uuid.UUID,
        from_version_id: uuid.UUID | None = None,
        to_version_id: uuid.UUID | None = None,
    ) -> None:
        """记一条操作记录。"""
        ...


class AgentStore(Protocol):
    """``agents``、``agent_drafts``、``agent_versions``、``agent_revisions``、``agent_skill_bindings``、
    ``agent_version_skills`` 的数据访问。"""

    async def list(self) -> tuple[AgentState, ...]:
        """全部 agent，按 ``sort_order`` 从小到大，同序按建立时刻倒序、再按 id 倒序。"""
        ...

    async def get(self, agent_id: str) -> AgentState | None: ...

    async def versions(self, agent_id: str) -> tuple[AgentVersion, ...]:
        """这个 agent 的全部版本，版本号从大到小。"""
        ...

    async def version(self, agent_id: str, version_id: uuid.UUID) -> AgentVersion | None:
        """这个 agent 的这个版本；不属于它给 ``None``。"""
        ...

    async def references(self) -> tuple[AgentRefs, ...]:
        """每个 agent 的草稿与当前版本各引用了什么，按 id 排。"""
        ...

    async def create(
        self,
        agent_id: str,
        *,
        name: str,
        description: str,
        config: Mapping[str, Any],
        by: uuid.UUID,
    ) -> None:
        """建一个在用、不上菜单的 agent，排在最后，连同空草稿与一条 create 操作记录，同一个事务；标识已被
        占用是 ``Conflict``。"""
        ...

    async def reorder(self, agent_ids: Sequence[str]) -> None:
        """按给的先后把 ``sort_order`` 写成 0..n-1。"""
        ...

    async def import_agents(self, agents: Sequence[ImportedAgent], *, by: uuid.UUID) -> None:
        """在一个事务里写完全部：已有的锁住后覆盖草稿（``lock_version`` 加一、``base_version_id`` 置空），
        没有的新建（排在最后、只有草稿）；每个 agent 记一条 import 操作记录。"""
        ...

    def edit(self, agent_id: str) -> AbstractAsyncContextManager[AgentWriter]:
        """开一次修改，见 ``AgentWriter``；没有这个 agent 是 ``NotFound``。"""
        ...


class ModelDirectory(Protocol):
    """查模型供应商，由组合根接到模型供应商域。"""

    async def provider(self, name: str) -> ProviderFacts | None:
        """按引用名找接入的供应商；没有给 ``None``。"""
        ...


class PluginDirectory(Protocol):
    """查本部署的插件登记表，由组合根接上；登记表里没有的插件就是不可用。"""

    def available(self) -> frozenset[str]:
        """本部署能挂的插件名。"""
        ...

    def requires(self, name: str) -> tuple[str, ...]:
        """挂这个插件时同一 agent 还要一起挂哪些插件；只对 ``available`` 里的名字调用。"""
        ...

    def parameter_problems(self, name: str, parameters: Mapping[str, Any]) -> tuple[Problem, ...]:
        """按插件自己的参数校验 ``parameters``；``path`` 相对参数本身（报在整体上为空串）。只对
        ``available`` 里的名字调用。"""
        ...

    def catalog(self) -> tuple[PluginFacts, ...]:
        """全部可挂的插件，配置页列出来供选择；按登记表的先后。"""
        ...


class SkillDirectory(Protocol):
    """查技能库，由组合根接到技能库域。"""

    async def skills(self) -> tuple[SkillFacts, ...]:
        """全部技能，含已归档的。"""
        ...


__all__ = [
    "AgentStore",
    "AgentWriter",
    "ImportedAgent",
    "ModelDirectory",
    "PluginDirectory",
    "SkillDirectory",
]
