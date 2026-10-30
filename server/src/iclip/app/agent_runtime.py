"""运行时从库里装配 agent：对话固定的版本（或某个 agent 的草稿）→ 编译 → 按版本号取缓存或装配。

每次运行先读出装配用到的全部东西的版本，拼成缓存键：agent 版本（草稿是它的 ``lock_version``）、各技能
最新版的内容 hash、子 agent 的当前版本与描述（连同它们的技能）、用到的供应商与密钥的修改时刻和模型本身。
键命中就复用装好的 Agent，没命中就装配后放进 LRU。发布 agent、发布技能、改密钥或模型之后，下一次运行
自然换成新的，不用通知，多个进程各自如此。

编译沿用发布时的检查（``compile_agent`` 的运行时模式），引用的模型被停用、插件已从代码里删掉、技能被
归档等装不起来的情况都报 ``AgentUnavailable``，只影响用到这个版本的对话。
"""

from __future__ import annotations

import hashlib
import json
import uuid
from collections import OrderedDict
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import structlog
from agent_runtime.errors import AgentUnavailable
from agent_runtime.model_vocab import ThinkingEffort

from iclip.app.model_providers import build_provider_model
from iclip.app.plugin_registry import PluginRegistry
from iclip.domains.agent_config.public import (
    AgentConfig,
    AgentConfigService,
    CompiledAgent,
    CompiledSubagent,
    load_config,
)
from iclip.domains.conversations.service import AgentDirectory, AgentEntry
from iclip.domains.model_providers.public import ModelProviderService, RuntimeModel
from iclip.domains.skills.public import Skill, SkillsService
from iclip.harness.agents import (
    SubAgentProfile,
    SubAgentSlot,
    build_agent,
    build_subagents,
    profile_metadata,
    subagent_profile,
)
from iclip.harness.models import BuiltModel
from iclip.harness.sessions import PgSessionStore
from iclip.harness.skills import (
    CachedSkill,
    build_skill_capabilities,
    cached_skill,
    materialize_skill,
)
from iclip.harness.step_store_pg import PgStepStore
from iclip.harness.titles import title_generator
from iclip.harness.transcript.runner import RunAgent
from iclip.harness.transcript.store import TranscriptStore
from iclip.harness.transcript.subagents import SubAgentMirror
from iclip.harness.usage_ledger import UsageLedger
from iclip.platform.transcript.display import ToolDisplayRegistry

_logger = structlog.stdlib.get_logger(__name__)

ModelBuilder = Callable[[RuntimeModel, ThinkingEffort | None], BuiltModel]
"""按供应商、模型与明文密钥建出 pydantic-ai 模型；测试换成替身。"""


def build_runtime_model(found: RuntimeModel, thinking: ThinkingEffort | None) -> BuiltModel:
    """``ModelBuilder`` 的生产实现：交给 ``build_provider_model``。"""

    return build_provider_model(found.declaration, found.model, found.fields, thinking)


@dataclass(frozen=True, slots=True)
class AssemblySettings:
    """装配用的启动期依赖：插件登记表、持久化与用量、实时投影、技能缓存目录与缓存条数。"""

    plugins: PluginRegistry
    step_store: PgStepStore
    usage_ledger: UsageLedger
    live: TranscriptStore
    display: ToolDisplayRegistry
    skill_cache_dir: Path
    cache_size: int
    build_model: ModelBuilder = build_runtime_model


@dataclass(frozen=True, slots=True)
class _Prepared:
    """一个 agent 装配前读齐的全部：编译结果、模型、技能（名字、最新版 id 与内容 hash）与子 agent。

    ``source`` 写明配置从哪来（版本或草稿），原样进运行记录的 metadata，也进缓存键。"""

    compiled: CompiledAgent
    model: RuntimeModel
    skills: tuple[Skill, ...]
    subagents: tuple[tuple[CompiledSubagent, _Prepared], ...]
    source: Mapping[str, str]

    @property
    def agent_id(self) -> str:
        return self.compiled.agent_id

    def fingerprint(self) -> dict[str, Any]:
        """缓存键的原料：装配用到的每样东西的版本。版本发布后不可变，草稿以 ``lock_version`` 标版本。"""

        model = self.model
        return {
            "agent": self.agent_id,
            "source": dict(self.source),
            "model": {
                "provider_id": str(model.provider.id),
                "provider_updated_at": model.provider.updated_at.isoformat(),
                "credential_id": str(model.credential_id),
                "credential_updated_at": model.credential_updated_at.isoformat(),
                # provider_models 没有修改时刻，自己加的模型改了属性要靠模型本身区分。
                "model": repr(model.model),
                "thinking": self.compiled.model.thinking,
            },
            "skills": [_skill_tag(skill) for skill in self.skills],
            "subagents": [
                {
                    "agent": sub.agent_id,
                    "description": sub.description,
                    "timeout_seconds": sub.timeout_seconds,
                    "max_calls": sub.max_calls,
                    "on_failure": sub.on_failure,
                    "assembly": prepared.fingerprint(),
                }
                for sub, prepared in self.subagents
            ],
        }


def _skill_tag(skill: Skill) -> str:
    return f"{skill.name}:{skill.latest_content_hash}"


def _cache_key(role: str, prepared: _Prepared) -> str:
    raw = json.dumps({"role": role, **prepared.fingerprint()}, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


@dataclass(frozen=True, slots=True)
class _Built:
    """装好的一份：Agent、它所用模型的上下文窗口与它当子代理时的档案。"""

    run: RunAgent
    profile: SubAgentProfile


class AgentRuntime:
    """按对话固定的版本装配 agent，也负责开运行时会话、首页名册与对话标题。

    同一个缓存键的两次并发装配会各装一份、后到的覆盖先到的，结果等价，不加锁。"""

    def __init__(
        self,
        *,
        agent_config: AgentConfigService,
        skills: SkillsService,
        model_providers: ModelProviderService,
        sessions: PgSessionStore,
        settings: AssemblySettings,
    ) -> None:
        self._agent_config = agent_config
        self._skills = skills
        self._model_providers = model_providers
        self._sessions = sessions
        self._settings = settings
        self._cache: OrderedDict[str, _Built] = OrderedDict()
        self._title_model: tuple[str, BuiltModel] | None = None

    # --- 运行 -----------------------------------------------------------------

    async def for_conversation(self, conversation_id: str, agent_id: str) -> RunAgent:
        """``RunAgents`` 的实现：按会话固定的版本装配。会话不在、版本为空或不是这个 agent 的都是
        ``AgentUnavailable``。"""

        version_id = await self._sessions.agent_version(uuid.UUID(conversation_id))
        if version_id is None:
            raise AgentUnavailable("这段对话没有可用的 agent 版本，请新开一段对话")
        version = await self._agent_config.runtime_version(agent_id, version_id)
        if version is None:
            raise AgentUnavailable("这段对话固定的 agent 版本已不存在，请新开一段对话")
        prepared = await self._prepare(
            agent_id,
            load_config(version.config),
            version.skill_ids,
            source={"agent_version_id": str(version.id)},
        )
        return self._assembled("top", prepared).run

    async def for_draft(self, agent_id: str) -> RunAgent:
        """按这个 agent 当前的草稿装配，给以后的预览用；运行记录标明是草稿。没有这个 agent 或草稿装不
        起来是 ``AgentUnavailable``。"""

        state = await self._agent_config.runtime_state(agent_id)
        if state is None:
            raise AgentUnavailable(f"没有标识为 {agent_id} 的 agent")
        prepared = await self._prepare(
            agent_id,
            load_config(state.draft.config),
            state.draft.skill_ids,
            source={
                "agent_draft_lock_version": str(state.draft.lock_version),
                "agent_draft": "true",
            },
        )
        return self._assembled("top", prepared).run

    async def _prepare(
        self,
        agent_id: str,
        config: AgentConfig,
        skill_ids: Sequence[uuid.UUID],
        *,
        source: Mapping[str, str],
    ) -> _Prepared:
        compiled = await self._agent_config.compile(agent_id, config, skill_ids, runtime=True)
        if not isinstance(compiled, CompiledAgent):
            raise AgentUnavailable(
                "；".join(
                    f"{problem.path}：{problem.message}" if problem.path else problem.message
                    for problem in compiled
                )
            )
        ref = compiled.model
        model = await self._model_providers.runtime_model(
            ref.provider, ref.model, ref.credential_id
        )
        if model is None:
            raise AgentUnavailable(f"模型 {ref.provider}/{ref.model} 或它的密钥已不在")
        catalog = {skill.id: skill for skill in await self._skills.catalog()}
        skills: list[Skill] = []
        for one in compiled.skills:
            skill = catalog.get(one.skill_id)
            if skill is None or skill.latest_version_id is None:
                raise AgentUnavailable(f"技能 {one.name} 已不在或没有发布过的版本")
            await self._materialize(skill)
            skills.append(skill)
        subagents: list[tuple[CompiledSubagent, _Prepared]] = []
        for sub in compiled.subagents:
            version = await self._agent_config.runtime_version(sub.agent_id, sub.version_id)
            if version is None:
                raise AgentUnavailable(f"子 agent {sub.agent_id} 的当前版本已不在")
            prepared = await self._prepare(
                sub.agent_id,
                load_config(version.config),
                version.skill_ids,
                source={"agent_version_id": str(version.id)},
            )
            subagents.append((sub, prepared))
        return _Prepared(
            compiled=compiled,
            model=model,
            skills=tuple(skills),
            subagents=tuple(subagents),
            source=source,
        )

    def _assembled(self, role: str, prepared: _Prepared) -> _Built:
        """按缓存键取；没有就装配并放进缓存，超出条数时丢掉最久没用的。"""

        key = _cache_key(role, prepared)
        found = self._cache.get(key)
        if found is not None:
            self._cache.move_to_end(key)
            return found
        built = self._build(role, prepared)
        self._cache[key] = built
        while len(self._cache) > self._settings.cache_size:
            self._cache.popitem(last=False)
        return built

    def _build(self, role: str, prepared: _Prepared) -> _Built:
        """装配一份；技能的文件在 ``_prepare`` 里已写进缓存目录。装配本身出错报装不起来。"""

        settings = self._settings
        compiled = prepared.compiled
        try:
            model = settings.build_model(prepared.model, compiled.model.thinking)
            profile = subagent_profile(prepared.agent_id, model)
            slots: list[SubAgentSlot] = []
            profiles: dict[str, SubAgentProfile] = {}
            for sub, sub_prepared in prepared.subagents:
                child = self._assembled("sub", sub_prepared)
                profiles[sub.agent_id] = child.profile
                slots.append(
                    SubAgentSlot(
                        name=sub.agent_id,
                        description=sub.description,
                        agent=child.run.agent,
                        timeout_seconds=sub.timeout_seconds,
                        max_calls=sub.max_calls,
                        on_failure=sub.on_failure,
                    )
                )
            extra = [
                *(
                    build_skill_capabilities(
                        settings.skill_cache_dir, self._cached_skills(prepared.skills)
                    )
                    if prepared.skills
                    else ()
                ),
                *(
                    [
                        build_subagents(
                            slots,
                            mirror=SubAgentMirror(
                                live=settings.live, display=settings.display, profiles=profiles
                            ),
                        )
                    ]
                    if slots
                    else ()
                ),
            ]
            top = role == "top"
            # 子运行沿用原有的三个键，实时任务卡与历史按它们读；顶层记下这次用的配置。
            run_metadata = _run_metadata(prepared, profile) if top else profile_metadata(profile)
            agent = build_agent(
                name=prepared.agent_id,
                model=model,
                instructions=compiled.instructions,
                plugins=compiled.capabilities,
                plugin_types=list(settings.plugins.values()),
                step_store=settings.step_store,
                usage_ledger=settings.usage_ledger,
                run_metadata=run_metadata,
                accepts_deferred=top,
                extra=extra,
            )
        except AgentUnavailable:
            raise
        except Exception as exc:
            _logger.exception("agent 装配失败", agent_id=prepared.agent_id)
            raise AgentUnavailable(f"agent {prepared.agent_id} 装配失败：{exc}") from exc
        return _Built(
            run=RunAgent(agent=agent, context_window=prepared.model.model.properties.context_size),
            profile=profile,
        )

    def _cached_skills(self, skills: Sequence[Skill]) -> list[CachedSkill]:
        root = self._settings.skill_cache_dir
        found: list[CachedSkill] = []
        for skill in skills:
            cached = cached_skill(root, name=skill.name, content_hash=_hash_of(skill))
            if cached is None:
                raise AgentUnavailable(f"技能 {skill.name} 的文件没有写进本机缓存")
            found.append(cached)
        return found

    async def _materialize(self, skill: Skill) -> None:
        """技能最新版的文件不在本机缓存里就读出来写进去；同一个内容 hash 只写一次。"""

        root = self._settings.skill_cache_dir
        content_hash = _hash_of(skill)
        if skill.latest_version_id is None or cached_skill(
            root, name=skill.name, content_hash=content_hash
        ):
            return
        files = await self._skills.version_files(skill.latest_version_id)
        materialize_skill(root, name=skill.name, content_hash=content_hash, files=files)

    # --- 会话 -----------------------------------------------------------------

    async def open_session(self, conversation_id: uuid.UUID, agent_id: str) -> None:
        """``OpenSession`` 的实现：固定这个 agent 此刻的当前版本。"""

        version_id = await self._agent_config.version_for_new_session(agent_id)
        await self._sessions.open(conversation_id, agent_version_id=version_id)

    async def fork_session(self, source_id: uuid.UUID, target_id: uuid.UUID) -> None:
        """``ForkSession`` 的实现：照抄源会话的版本。"""

        await self._sessions.copy(source_id, target_id)

    # --- 首页与标题 -------------------------------------------------------------

    async def directory(self) -> AgentDirectory:
        """``ListAgents`` 的实现：上菜单、在用、发布过的 agent，按 ``sort_order``，第一个是默认项。"""

        states = await self._agent_config.listed()
        items = tuple(AgentEntry(id=state.agent.id, name=state.agent.name) for state in states)
        return AgentDirectory(items=items, default=items[0].id if items else None)

    async def generate_title(self, user_text: str) -> str | None:
        """``GenerateTitle`` 的实现：用默认的对话模型起标题；没设默认模型就不起。"""

        found = await self._model_providers.default_llm()
        if found is None:
            return None
        key = "|".join(
            (
                str(found.provider.id),
                found.provider.updated_at.isoformat(),
                str(found.credential_id),
                found.credential_updated_at.isoformat(),
                repr(found.model),
            )
        )
        if self._title_model is None or self._title_model[0] != key:
            try:
                model = self._settings.build_model(found, None)
            except Exception:
                # 起标题失败只是还叫默认名（合同如此），下一轮再试；原因记下来。
                _logger.warning("建不出起标题的模型，这段对话先用默认名", exc_info=True)
                return None
            self._title_model = (key, model)
        return await title_generator(self._title_model[1])(user_text)


def _hash_of(skill: Skill) -> str:
    if skill.latest_content_hash is None:
        raise AgentUnavailable(f"技能 {skill.name} 没有发布过的版本")
    return skill.latest_content_hash


def _run_metadata(prepared: _Prepared, profile: SubAgentProfile) -> dict[str, str]:
    """顶层运行的落库 metadata（str→str）：agent、版本或草稿、模型、思考档位与技能。"""

    metadata = {"agent_id": prepared.agent_id, **prepared.source, "model": profile["model"]}
    if "thinking_effort" in profile:
        metadata["thinking_effort"] = profile["thinking_effort"]
    if prepared.skills:
        metadata["skills"] = ",".join(_skill_tag(skill) for skill in prepared.skills)
    return metadata


__all__ = ["AgentRuntime", "AssemblySettings", "ModelBuilder", "build_runtime_model"]
