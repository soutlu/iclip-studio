"""集成测试里往库里种 agent：一个按百炼声明接入的测试供应商（密钥用 ``GOOD_KEY``）、自己加的测试模型、
技能与发布好的 agent。全部经各领域的服务写，与配置页走同一套校验与发布检查。

运行时按模型名把模型换成测试替身（见 ``model_builder``），所以这里种的模型只是名字，不连真实端点。"""

from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from agent_runtime.assembly.agents import ModelBuilder
from agent_runtime.config.agent_config.config import AgentConfig
from agent_runtime.config.agent_config.schemas import (
    AgentCreateIn,
    AgentDraftIn,
    AgentPublishIn,
    AgentUpdateIn,
)
from agent_runtime.config.model_providers.public import RuntimeModel
from agent_runtime.config.model_providers.schemas import (
    CredentialCreateIn,
    CustomModelCreateIn,
    ModelProviderCreateIn,
)
from agent_runtime.config.skills.schemas import DraftFileWriteIn, SkillCreateIn, SkillPublishIn
from agent_runtime.model_vocab import ThinkingEffort
from pydantic_ai.models import Model
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.app.bootstrap import AgentServices
from tests.helpers.app import TEST_MODEL_NAME
from tests.helpers.model_providers import GOOD_KEY
from tests.helpers.references import plant_user

TEST_PROVIDER = "test-provider"
"""种下的供应商引用名（按百炼声明接入）。"""

SEEDER = "agent-seeder"
"""种 agent 时建的作者账号的用户名；数用户的用例把它除外。"""


@dataclass(frozen=True)
class SkillSeed:
    """一个技能：标识、描述、正文与 ``references/`` 下的文件（文件名 → 内容）。"""

    name: str
    description: str = "测试用的技能。"
    body: str = "照着流程做。"
    references: Mapping[str, str] = field(default_factory=dict[str, str])


@dataclass(frozen=True)
class SubagentSeed:
    """派活给哪个 agent（它要先种好）与三个控制项。"""

    agent: str
    timeout_seconds: float | None = None
    max_calls: int | None = None
    on_failure: str | None = None


@dataclass(frozen=True)
class AgentSeed:
    """种一个 agent 并发布 v1。``listed`` 为假的是只当子 agent 用的。"""

    agent_id: str
    model: str = TEST_MODEL_NAME
    instructions: str = ""
    plugins: tuple[str, ...] = ()
    skills: tuple[SkillSeed, ...] = ()
    subagents: tuple[SubagentSeed, ...] = ()
    listed: bool = True
    description: str = ""
    thinking: ThinkingEffort | None = None


CONVERSABLE_SEEDS = (AgentSeed("storyboard"), AgentSeed("director"))
"""只是要能开对话的测试种这两个：首页上能选、发布过、没有工具。"""


@dataclass
class Seeded:
    """种完之后测试要用的 id：作者、供应商、各模型名、技能 id 与各 agent 的 v1。"""

    author: uuid.UUID
    provider_id: uuid.UUID
    skills: dict[str, uuid.UUID] = field(default_factory=dict[str, uuid.UUID])
    versions: dict[str, uuid.UUID] = field(default_factory=dict[str, uuid.UUID])


def model_builder(models: Mapping[str, Model]) -> ModelBuilder:
    """按模型名换成测试替身；没登记的名字直接报错，装配会把它报成 agent 装不起来。"""

    def build(found: RuntimeModel, _thinking: ThinkingEffort | None) -> Model:
        return models[found.model.name]

    return build


async def seed_provider(
    services: AgentServices,
    engine: AsyncEngine,
    *,
    models: Sequence[str] = (TEST_MODEL_NAME,),
    context_sizes: Mapping[str, int] | None = None,
    thinking: Sequence[ThinkingEffort] = (),
) -> Seeded:
    """建作者、接入测试供应商、加一把默认密钥，并把 ``models`` 加成自己加的 llm 模型（走 chat）。"""

    author = await plant_user(engine, SEEDER)
    providers = services.model_providers
    provider = await providers.create(
        ModelProviderCreateIn(name=TEST_PROVIDER, provider="bailian", label="测试供应商")
    )
    await providers.create_credential(
        provider.id,
        CredentialCreateIn(name="主账号", fields={"api_key": GOOD_KEY}),
        created_by=author,
    )
    for name in models:
        await providers.add_model(
            provider.id,
            CustomModelCreateIn(
                name=name,
                type="llm",
                api="chat",
                context_size=(context_sizes or {}).get(name),
                thinking=list(thinking),
            ),
        )
    return Seeded(author=author, provider_id=provider.id)


async def seed_skill(services: AgentServices, seeded: Seeded, skill: SkillSeed) -> uuid.UUID:
    """建一个技能、写好正文与参考文件并发布，交回技能 id；同名的已种过就直接用。"""

    if skill.name in seeded.skills:
        return seeded.skills[skill.name]
    library = services.skills
    created = await library.create(
        SkillCreateIn(name=skill.name, display_name=skill.name, description=skill.description),
        by=seeded.author,
    )
    current = await library.read_file(created.id, "SKILL.md")
    await library.write_file(
        created.id,
        "SKILL.md",
        DraftFileWriteIn(
            content=f"---\nname: {skill.name}\ndescription: {skill.description}\n---\n\n{skill.body}\n",
            base_hash=current.hash,
        ),
        by=seeded.author,
    )
    for name, content in skill.references.items():
        await library.write_file(
            created.id,
            f"references/{name}",
            DraftFileWriteIn(content=content, base_hash=None),
            by=seeded.author,
        )
    await library.publish(created.id, SkillPublishIn(), by=seeded.author)
    seeded.skills[skill.name] = created.id
    return created.id


def agent_config(seed: AgentSeed) -> AgentConfig:
    model: dict[str, Any] = {"provider": TEST_PROVIDER, "name": seed.model}
    if seed.thinking is not None:
        model["settings"] = {"thinking": seed.thinking}
    return AgentConfig.model_validate(
        {
            "schema_version": 1,
            "instructions": seed.instructions,
            "model": model,
            "tools": [
                {"type": "cap", "toolset": name, "enabled": True, "parameters": {}}
                for name in seed.plugins
            ],
            "subagents": [
                {
                    "agent": sub.agent,
                    "timeout_seconds": sub.timeout_seconds,
                    "max_calls": sub.max_calls,
                    "on_failure": sub.on_failure,
                }
                for sub in seed.subagents
            ],
        }
    )


async def save_and_publish(
    services: AgentServices,
    seeded: Seeded,
    agent_id: str,
    config: AgentConfig,
    skill_ids: Sequence[uuid.UUID] = (),
) -> uuid.UUID:
    """整份保存草稿再发布，交回新版本 id。"""

    agents = services.agent_config
    detail = await agents.detail(agent_id)
    saved = await agents.save_draft(
        agent_id,
        AgentDraftIn(
            config=config, skill_ids=list(skill_ids), lock_version=detail.draft.lock_version
        ),
        by=seeded.author,
    )
    version = await agents.publish(
        agent_id,
        AgentPublishIn(lock_version=saved.draft.lock_version),
        by=seeded.author,
    )
    return version.id


async def seed_agent(services: AgentServices, seeded: Seeded, seed: AgentSeed) -> uuid.UUID:
    """建 agent、存草稿、发布 v1，``listed`` 照种子设；交回 v1 的 id。"""

    agents = services.agent_config
    await agents.create(
        AgentCreateIn(id=seed.agent_id, name=seed.agent_id, description=seed.description),
        by=seeded.author,
    )
    skill_ids = [await seed_skill(services, seeded, skill) for skill in seed.skills]
    version_id = await save_and_publish(
        services, seeded, seed.agent_id, agent_config(seed), skill_ids
    )
    if seed.listed:
        await agents.update(seed.agent_id, AgentUpdateIn(listed=True))
    seeded.versions[seed.agent_id] = version_id
    return version_id


async def seed_agents(
    services: AgentServices, engine: AsyncEngine, seeds: Sequence[AgentSeed]
) -> Seeded:
    """接入测试供应商（种子用到的模型都加上）并依次种下 ``seeds``；子 agent 要排在用它的 agent 前面。"""

    seeded = await seed_provider(
        services,
        engine,
        models=tuple(dict.fromkeys(seed.model for seed in seeds)),
        thinking=tuple(dict.fromkeys(seed.thinking for seed in seeds if seed.thinking)),
    )
    for seed in seeds:
        await seed_agent(services, seeded, seed)
    return seeded


__all__ = [
    "CONVERSABLE_SEEDS",
    "SEEDER",
    "TEST_PROVIDER",
    "AgentSeed",
    "Seeded",
    "SkillSeed",
    "SubagentSeed",
    "agent_config",
    "model_builder",
    "save_and_publish",
    "seed_agent",
    "seed_agents",
    "seed_provider",
    "seed_skill",
]
