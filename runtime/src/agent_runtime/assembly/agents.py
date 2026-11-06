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

from agent_runtime.assembly.mcp import mcp_connection
from agent_runtime.assembly.models import build_provider_model
from agent_runtime.config.agent_config.public import (
    AgentConfig,
    AgentConfigService,
    CompiledAgent,
    CompiledMcpServer,
    CompiledSubagent,
    load_config,
)
from agent_runtime.config.mcp_servers.public import McpServerService, RuntimeMcpServer
from agent_runtime.config.model_providers.public import ModelProviderService, RuntimeModel
from agent_runtime.config.skills.public import (
    SKILL_MD,
    Skill,
    SkillsService,
    with_frontmatter_name,
)
from agent_runtime.errors import AgentUnavailable, ValidationFailed
from agent_runtime.harness.agents import (
    SubAgentProfile,
    SubAgentSlot,
    build_agent,
    build_subagents,
    profile_metadata,
    subagent_profile,
)
from agent_runtime.harness.mcp import mcp_capability
from agent_runtime.harness.models import BuiltModel
from agent_runtime.harness.sessions import PgSessionStore
from agent_runtime.harness.skills import (
    CachedSkill,
    build_skill_capabilities,
    cached_skill,
    materialize_skill,
)
from agent_runtime.harness.step_store_pg import PgStepStore
from agent_runtime.harness.titles import title_generator
from agent_runtime.harness.transcript.runner import RunAgent
from agent_runtime.harness.transcript.store import TranscriptStore
from agent_runtime.harness.transcript.subagents import SubAgentMirror
from agent_runtime.harness.usage_ledger import UsageLedger
from agent_runtime.model_vocab import ThinkingEffort
from agent_runtime.plugins.base import PluginRegistry
from agent_runtime.transcript.display import ToolDisplayRegistry

_logger = structlog.stdlib.get_logger(__name__)

ModelBuilder = Callable[[RuntimeModel, ThinkingEffort | None], BuiltModel]


def build_runtime_model(found: RuntimeModel, thinking: ThinkingEffort | None) -> BuiltModel:
    return build_provider_model(found.declaration, found.model, found.fields, thinking)


@dataclass(frozen=True, slots=True)
class AgentEntry:
    id: str
    name: str


@dataclass(frozen=True, slots=True)
class AgentDirectory:
    items: tuple[AgentEntry, ...]
    default: str | None


@dataclass(frozen=True, slots=True)
class AssemblySettings:
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
    compiled: CompiledAgent
    model: RuntimeModel
    mcp_servers: tuple[tuple[CompiledMcpServer, RuntimeMcpServer], ...]
    skills: tuple[Skill, ...]
    subagents: tuple[tuple[CompiledSubagent, _Prepared], ...]
    source: Mapping[str, str]

    @property
    def agent_id(self) -> str:
        return self.compiled.agent_id

    def fingerprint(self) -> dict[str, Any]:
        model = self.model
        return {
            "agent": self.agent_id,
            "source": dict(self.source),
            "model": {
                "provider_id": str(model.provider.id),
                "provider_updated_at": model.provider.updated_at.isoformat(),
                "credential_id": str(model.credential_id),
                "credential_updated_at": model.credential_updated_at.isoformat(),
                "model": repr(model.model),
                "thinking": self.compiled.model.thinking,
            },
            "mcp_servers": [
                {
                    "server": server.id,
                    "updated_at": server.updated_at.isoformat(),
                    "tools": list(compiled.tools) if compiled.tools is not None else None,
                    "tool_prefix": compiled.tool_prefix,
                }
                for compiled, server in self.mcp_servers
            ],
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
    run: RunAgent
    profile: SubAgentProfile


class AgentRuntime:
    def __init__(
        self,
        *,
        agent_config: AgentConfigService,
        skills: SkillsService,
        model_providers: ModelProviderService,
        mcp_servers: McpServerService,
        sessions: PgSessionStore,
        settings: AssemblySettings,
    ) -> None:
        self._agent_config = agent_config
        self._skills = skills
        self._model_providers = model_providers
        self._mcp_servers = mcp_servers
        self._sessions = sessions
        self._settings = settings
        self._cache: OrderedDict[str, _Built] = OrderedDict()
        self._title_model: tuple[str, BuiltModel] | None = None

    async def for_conversation(self, conversation_id: str, agent_id: str) -> RunAgent:
        target = await self._sessions.target(uuid.UUID(conversation_id))
        if target is not None and target.preview_agent_id is not None:
            if agent_id != target.preview_agent_id:
                raise ValidationFailed(f"这段预览只能跑 {target.preview_agent_id}")
            if target.agent_version_id is None:
                return await self.for_draft(agent_id)
        version_id = None if target is None else target.agent_version_id
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
        mcp_servers: list[tuple[CompiledMcpServer, RuntimeMcpServer]] = []
        for compiled_server in compiled.mcp_servers:
            server = await self._mcp_servers.runtime_server(compiled_server.server_id)
            if server is None:
                raise AgentUnavailable(f"MCP 服务 {compiled_server.server_id} 已不在")
            mcp_servers.append((compiled_server, server))
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
            mcp_servers=tuple(mcp_servers),
            skills=tuple(skills),
            subagents=tuple(subagents),
            source=source,
        )

    def _assembled(self, role: str, prepared: _Prepared) -> _Built:
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
                    mcp_capability(
                        server_id=server.id,
                        server_name=server.name,
                        connection=mcp_connection(server.endpoint),
                        tools=compiled_server.tools,
                        tool_prefix=compiled_server.tool_prefix,
                    )
                    for compiled_server, server in prepared.mcp_servers
                ),
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
            cached = cached_skill(root, name=skill.name, key=_skill_dir_key(skill))
            if cached is None:
                raise AgentUnavailable(f"技能 {skill.name} 的文件没有写进本机缓存")
            found.append(cached)
        return found

    async def _materialize(self, skill: Skill) -> None:
        root = self._settings.skill_cache_dir
        key = _skill_dir_key(skill)
        if skill.latest_version_id is None or cached_skill(root, name=skill.name, key=key):
            return
        files = dict(await self._skills.version_files(skill.latest_version_id))
        files[SKILL_MD] = with_frontmatter_name(files[SKILL_MD], skill.name)
        materialize_skill(root, name=skill.name, key=key, files=files)

    async def directory(self) -> AgentDirectory:
        states = await self._agent_config.listed()
        items = tuple(AgentEntry(id=state.agent.id, name=state.agent.name) for state in states)
        return AgentDirectory(items=items, default=items[0].id if items else None)

    async def generate_title(self, user_text: str) -> str | None:
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
                _logger.warning("建不出起标题的模型，这段对话先用默认名", exc_info=True)
                return None
            self._title_model = (key, model)
        return await title_generator(self._title_model[1])(user_text)


def _skill_dir_key(skill: Skill) -> str:
    if skill.latest_content_hash is None:
        raise AgentUnavailable(f"技能 {skill.name} 没有发布过的版本")
    return hashlib.sha256(f"{skill.latest_content_hash}\n{skill.name}".encode()).hexdigest()


def _run_metadata(prepared: _Prepared, profile: SubAgentProfile) -> dict[str, str]:
    metadata = {"agent_id": prepared.agent_id, **prepared.source, "model": profile["model"]}
    if "thinking_effort" in profile:
        metadata["thinking_effort"] = profile["thinking_effort"]
    if prepared.skills:
        metadata["skills"] = ",".join(_skill_tag(skill) for skill in prepared.skills)
    return metadata


__all__ = [
    "AgentDirectory",
    "AgentEntry",
    "AgentRuntime",
    "AssemblySettings",
    "ModelBuilder",
    "build_runtime_model",
]
