"""Agent 配置用例连真实 Postgres（技能库与模型供应商也是真的，插件登记表用测试替身）：发布是原子的、草稿按
lockVersion 防覆盖、内容不变不出新版本、版本号递增、恢复后草稿等于那一版、归档被引用的 agent 是 409、导入
检查不写库且有问题时正式导入也不写、覆盖导入只改草稿、导出再导入得到同样的配置，以及技能、模型、密钥、
供应商被草稿或当前版本引用时拦下、只被旧版本引用时放行。"""

from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

import pytest
import yaml
from agent_runtime.assembly.directories import LibrarySkillDirectory, ProviderDirectory
from agent_runtime.config.agent_config.config import AgentConfig
from agent_runtime.config.agent_config.infra_sql import SqlAgentStore
from agent_runtime.config.agent_config.public import AgentReferences
from agent_runtime.config.agent_config.schemas import (
    AgentCreateIn,
    AgentDraftIn,
    AgentOrderIn,
    AgentPublishIn,
    AgentRestoreIn,
    AgentUpdateIn,
)
from agent_runtime.config.agent_config.service import AgentConfigService, AgentPublishBlocked
from agent_runtime.config.model_providers.catalog import load_declarations
from agent_runtime.config.model_providers.cipher import CredentialCipher
from agent_runtime.config.model_providers.infra_sql import SqlModelProviderStore
from agent_runtime.config.model_providers.schemas import (
    CredentialCreateIn,
    CustomModelCreateIn,
    ModelProviderCreateIn,
    ModelProviderUpdateIn,
    ModelUpdateIn,
)
from agent_runtime.config.model_providers.service import ModelProviderService
from agent_runtime.config.skills.infra_sql import SqlSkillStore
from agent_runtime.config.skills.schemas import SkillCreateIn, SkillPublishIn
from agent_runtime.config.skills.service import SkillsService
from agent_runtime.errors import Conflict, NotFound, ValidationFailed
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncEngine

from tests.helpers.agent_config import NOTES, FakePlugins
from tests.helpers.app import TEST_CREDENTIAL_KEY
from tests.helpers.model_providers import GOOD_KEY, OTHER_KEY, KeyCheckingProbe
from tests.helpers.references import plant_user

TABLES = (
    "agents",
    "agent_drafts",
    "agent_versions",
    "agent_revisions",
    "agent_skill_bindings",
    "agent_version_skills",
)
MODEL = "qwen3.8-flash"
OTHER_MODEL = "ZHIPU/GLM-5.3-Flash"


@dataclass
class World:
    agents: AgentConfigService
    skills: SkillsService
    providers: ModelProviderService
    author: uuid.UUID
    provider_id: uuid.UUID
    provider: str
    default_key: uuid.UUID
    spare_key: uuid.UUID
    skill_id: uuid.UUID


@pytest.fixture
async def world(engine: AsyncEngine) -> World:
    author = await plant_user(engine, "agent-author")
    agent_store = SqlAgentStore(engine)
    references = AgentReferences(agent_store)
    skills = SkillsService(SqlSkillStore(engine), usages=references)
    providers = ModelProviderService(
        SqlModelProviderStore(engine),
        declarations=load_declarations(),
        cipher=CredentialCipher([TEST_CREDENTIAL_KEY]),
        probe=KeyCheckingProbe({GOOD_KEY, OTHER_KEY}),
        usages=references,
    )
    agents = AgentConfigService(
        agent_store,
        models=ProviderDirectory(providers),
        plugins=FakePlugins(),
        skills=LibrarySkillDirectory(skills),
    )
    provider = await providers.create(
        ModelProviderCreateIn(name="bailian-main", provider="bailian", label="百炼")
    )
    default_key = await providers.create_credential(
        provider.id,
        CredentialCreateIn(name="主账号", fields={"api_key": GOOD_KEY}),
        created_by=author,
    )
    spare_key = await providers.create_credential(
        provider.id,
        CredentialCreateIn(name="备用", fields={"api_key": OTHER_KEY}),
        created_by=author,
    )
    skill = await skills.create(
        SkillCreateIn(name="pdf-tools", display_name="PDF 工具", description="处理 PDF"), by=author
    )
    await skills.publish(skill.id, SkillPublishIn(), by=author)
    return World(
        agents=agents,
        skills=skills,
        providers=providers,
        author=author,
        provider_id=provider.id,
        provider=provider.name,
        default_key=default_key.id,
        spare_key=spare_key.id,
        skill_id=skill.id,
    )


def config(world: World, **fields: Any) -> AgentConfig:
    return AgentConfig.model_validate(
        {"schema_version": 1, "model": {"provider": world.provider, "name": MODEL}, **fields}
    )


async def new_agent(world: World, agent_id: str) -> None:
    await world.agents.create(AgentCreateIn(id=agent_id, name=agent_id.title()), by=world.author)


async def save(
    world: World,
    agent_id: str,
    agent_config: AgentConfig,
    skill_ids: list[uuid.UUID] | None = None,
) -> int:
    """整份保存草稿，交回新的 lockVersion。"""

    current = await world.agents.detail(agent_id)
    saved = await world.agents.save_draft(
        agent_id,
        AgentDraftIn(
            config=agent_config, skill_ids=skill_ids or [], lock_version=current.draft.lock_version
        ),
        by=world.author,
    )
    return saved.draft.lock_version


async def publish(world: World, agent_id: str, note: str | None = None) -> uuid.UUID:
    lock = (await world.agents.detail(agent_id)).draft.lock_version
    version = await world.agents.publish(
        agent_id, AgentPublishIn(note=note, lock_version=lock), by=world.author
    )
    return version.id


async def ready_agent(world: World, agent_id: str, **fields: Any) -> uuid.UUID:
    """建一个 agent、存好可发布的草稿并发布，交回版本 id。"""

    await new_agent(world, agent_id)
    await save(world, agent_id, config(world, **fields), [world.skill_id])
    return await publish(world, agent_id)


async def row_counts(engine: AsyncEngine) -> dict[str, int]:
    async with engine.connect() as conn:
        return {
            table: (
                await conn.execute(text(f"SELECT count(*) FROM agent_runtime.{table}"))
            ).scalar_one()
            for table in TABLES
        }


async def operations(engine: AsyncEngine, agent_id: str) -> list[str]:
    async with engine.connect() as conn:
        rows = await conn.execute(
            text(
                "SELECT operation FROM agent_runtime.agent_revisions WHERE agent_id = :id"
                " ORDER BY created_at, operation"
            ),
            {"id": agent_id},
        )
        return [operation for (operation,) in rows]


@asynccontextmanager
async def failing_version_skills(engine: AsyncEngine) -> AsyncGenerator[None]:
    """块内往 ``agent_version_skills`` 插行时报错：发布写完版本行之后才失败。触发器用完必须删掉。"""

    async with engine.begin() as conn:
        await conn.execute(
            text(
                "CREATE FUNCTION agent_runtime.test_fail_agent_version_skills() RETURNS trigger"
                " LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'version skills refused'; END $$"
            )
        )
        await conn.execute(
            text(
                "CREATE TRIGGER test_fail_agent_version_skills"
                " BEFORE INSERT ON agent_runtime.agent_version_skills"
                " FOR EACH ROW EXECUTE FUNCTION agent_runtime.test_fail_agent_version_skills()"
            )
        )
    try:
        yield
    finally:
        async with engine.begin() as conn:
            await conn.execute(
                text(
                    "DROP TRIGGER test_fail_agent_version_skills"
                    " ON agent_runtime.agent_version_skills"
                )
            )
            await conn.execute(text("DROP FUNCTION agent_runtime.test_fail_agent_version_skills()"))


async def test_a_reserved_word_cannot_name_a_new_agent(world: World, engine: AsyncEngine) -> None:
    """``/agents/`` 下固定路径的那几段不能当标识：新建与导入新 agent 都拦下，什么都不写。"""

    with pytest.raises(ValidationFailed, match="plugins 是保留词"):
        await world.agents.create(AgentCreateIn(id="plugins", name="插件"), by=world.author)
    assert await operations(engine, "plugins") == []

    package = {
        "format_version": "1.0.0",
        "entry": "order",
        "agents": {"order": {"name": "排序", "config": {"schema_version": 1}}},
    }
    data = yaml.safe_dump(package, allow_unicode=True).encode()
    report = await world.agents.import_package(data, dry_run=True, by=world.author)
    (item,) = report.agents
    assert (item.agent_id, item.action) == ("order", "create")
    assert [(one.path, one.message) for one in item.problems] == [
        ("", "order 是保留词，不能用作标识")
    ]
    with pytest.raises(ValidationFailed, match="order 是保留词"):
        await world.agents.import_package(data, dry_run=False, by=world.author)


async def test_publish_versions_increase_and_clear_unpublished_changes(
    world: World, engine: AsyncEngine
) -> None:
    first = await ready_agent(world, "director")
    detail = await world.agents.detail("director")
    assert detail.active_version is not None and detail.active_version.id == first
    assert detail.active_version.version == 1
    assert detail.has_unpublished_changes is False
    assert detail.draft.base_version_id == first

    with pytest.raises(ValidationFailed, match="没有可发布的改动"):
        await publish(world, "director")

    await save(world, "director", config(world, instructions="改过了"), [world.skill_id])
    assert (await world.agents.detail("director")).has_unpublished_changes is True
    second = await publish(world, "director", note="第二版")

    versions = await world.agents.versions("director")
    assert [(one.id, one.version, one.note) for one in versions.items] == [
        (second, 2, "第二版"),
        (first, 1, None),
    ]
    assert await operations(engine, "director") == ["create", "publish", "publish"]


async def test_skill_order_change_alone_is_publishable(world: World) -> None:
    await ready_agent(world, "director")
    other = await world.skills.create(
        SkillCreateIn(name="docx-tools", display_name="Word", description="处理 Word"),
        by=world.author,
    )
    await world.skills.publish(other.id, SkillPublishIn(), by=world.author)
    await save(world, "director", config(world), [world.skill_id, other.id])
    await publish(world, "director")
    await save(world, "director", config(world), [other.id, world.skill_id])

    version_id = await publish(world, "director")
    assert (await world.agents.version("director", version_id)).skill_ids == [
        other.id,
        world.skill_id,
    ]


async def test_stale_lock_version_is_a_conflict(world: World) -> None:
    await new_agent(world, "director")
    lock = await save(world, "director", config(world))

    with pytest.raises(Conflict):
        await world.agents.save_draft(
            "director",
            AgentDraftIn(config=config(world), skill_ids=[], lock_version=lock - 1),
            by=world.author,
        )
    with pytest.raises(Conflict):
        await world.agents.publish(
            "director", AgentPublishIn(lock_version=lock - 1), by=world.author
        )
    assert (await world.agents.detail("director")).draft.lock_version == lock


async def test_draft_skill_list_must_name_existing_distinct_skills(world: World) -> None:
    await new_agent(world, "director")
    with pytest.raises(ValidationFailed, match="skills\\[1\\]"):
        await save(world, "director", config(world), [world.skill_id, uuid.uuid4()])
    with pytest.raises(ValidationFailed, match="重复"):
        await save(world, "director", config(world), [world.skill_id, world.skill_id])


async def test_incomplete_draft_saves_but_cannot_publish(world: World) -> None:
    await new_agent(world, "director")
    await save(
        world,
        "director",
        AgentConfig.model_validate(
            {"schema_version": 1, "tools": [{"type": "cap", "toolset": "unknown-plugin"}]}
        ),
    )

    with pytest.raises(AgentPublishBlocked) as blocked:
        await publish(world, "director")
    assert {one.path for one in blocked.value.problems} == {"model", "tools[0]"}


async def test_failed_publish_leaves_no_version_and_keeps_the_pointer(
    world: World, engine: AsyncEngine
) -> None:
    first = await ready_agent(world, "director")
    await save(world, "director", config(world, instructions="第二版"), [world.skill_id])
    before = await row_counts(engine)

    async with failing_version_skills(engine):
        with pytest.raises(DBAPIError):
            await publish(world, "director")

    assert await row_counts(engine) == before
    detail = await world.agents.detail("director")
    assert detail.active_version is not None and detail.active_version.id == first
    assert detail.draft.base_version_id == first


async def test_restore_copies_the_version_back_into_the_draft(
    world: World, engine: AsyncEngine
) -> None:
    first = await ready_agent(world, "director", instructions="第一版")
    await save(world, "director", config(world, instructions="第二版"), [])
    await publish(world, "director")
    detail = await world.agents.detail("director")

    with pytest.raises(Conflict):
        await world.agents.restore(
            "director",
            first,
            AgentRestoreIn(lock_version=detail.draft.lock_version - 1),
            by=world.author,
        )
    restored = await world.agents.restore(
        "director", first, AgentRestoreIn(lock_version=detail.draft.lock_version), by=world.author
    )

    version = await world.agents.version("director", first)
    assert (restored.draft.config, restored.draft.skill_ids) == (version.config, version.skill_ids)
    assert restored.draft.base_version_id == first
    assert restored.draft.lock_version == detail.draft.lock_version + 1
    assert restored.active_version is not None and restored.active_version.version == 2
    assert (await operations(engine, "director"))[-1] == "restore"
    with pytest.raises(NotFound):
        await world.agents.restore(
            "director",
            uuid.uuid4(),
            AgentRestoreIn(lock_version=restored.draft.lock_version),
            by=world.author,
        )


async def test_meta_changes_apply_immediately_and_reorder_needs_every_agent(
    world: World,
) -> None:
    await new_agent(world, "alpha")
    await new_agent(world, "beta")

    updated = await world.agents.update(
        "alpha", AgentUpdateIn(name="甲", description="派活用", listed=True)
    )
    assert (updated.name, updated.description, updated.listed) == ("甲", "派活用", True)
    assert [one.id for one in (await world.agents.list()).items] == ["alpha", "beta"]

    reordered = await world.agents.reorder(AgentOrderIn(ids=["beta", "alpha"]))
    assert [(one.id, one.sort_order) for one in reordered.items] == [("beta", 0), ("alpha", 1)]
    with pytest.raises(ValidationFailed):
        await world.agents.reorder(AgentOrderIn(ids=["beta"]))


async def test_subagents_compile_and_referenced_agent_cannot_be_archived(
    world: World, engine: AsyncEngine
) -> None:
    await ready_agent(world, "helper")
    await world.agents.update("helper", AgentUpdateIn(description="帮忙拆解"))
    await ready_agent(world, "director", subagents=[{"agent": "helper", "max_calls": 2}])

    with pytest.raises(Conflict, match="director"):
        await world.agents.archive("helper", by=world.author)
    assert [one.agent_id for one in (await world.agents.detail("helper")).used_by] == ["director"]

    await save(world, "helper", config(world, subagents=[{"agent": "director"}]), [])
    with pytest.raises(AgentPublishBlocked) as blocked:
        await publish(world, "helper")
    assert {one.path for one in blocked.value.problems} >= {"subagents"}

    await save(world, "director", config(world), [])
    await publish(world, "director")
    await save(world, "helper", config(world), [world.skill_id])
    archived = await world.agents.archive("helper", by=world.author)
    assert archived.status == "archived"
    assert (await operations(engine, "helper"))[-1] == "archive"
    await world.agents.unarchive("helper", by=world.author)
    assert (await operations(engine, "helper"))[-1] == "unarchive"


async def test_export_then_import_gives_the_same_config(world: World) -> None:
    await ready_agent(world, "helper")
    await ready_agent(
        world,
        "director",
        model={"provider": world.provider, "name": MODEL, "credential_id": str(world.spare_key)},
        tools=[{"type": "cap", "toolset": NOTES, "parameters": {"limit": 3}}],
        subagents=[{"agent": "helper", "timeout_seconds": 600}],
    )
    exported = await world.agents.export("director")
    document = yaml.safe_load(exported.content)
    assert exported.filename == "director-v1.yaml"
    assert list(document["agents"]) == ["director", "helper"]
    assert "credential_id" not in document["agents"]["director"]["config"]["model"]
    assert document["agents"]["director"]["skills"] == ["pdf-tools"]

    imported = await world.agents.import_package(
        exported.content.encode(), dry_run=False, by=world.author
    )
    assert [(one.agent_id, one.action) for one in imported.agents] == [
        ("director", "overwrite"),
        ("helper", "overwrite"),
    ]

    detail = await world.agents.detail("director")
    assert detail.active_version is not None
    active = await world.agents.version("director", detail.active_version.id)
    assert active.config.model is not None and detail.draft.config.model is not None
    # 密钥只属于本环境，导出时去掉；其余与当前版本一字不差。
    assert detail.draft.config == active.config.model_copy(
        update={"model": active.config.model.model_copy(update={"credential_id": None})}
    )
    assert detail.draft.skill_ids == active.skill_ids


async def test_import_check_writes_nothing_and_problems_block_the_real_import(
    world: World, engine: AsyncEngine
) -> None:
    package = {
        "format_version": "1.0.0",
        "entry": "director",
        "agents": {
            "director": {
                "name": "导演",
                "config": {
                    "schema_version": 1,
                    "model": {"provider": world.provider, "name": MODEL},
                    "subagents": [{"agent": "helper"}],
                },
                "skills": ["pdf-tools"],
            },
            "helper": {"name": "帮手", "config": {"schema_version": 1}},
        },
    }
    data = yaml.safe_dump(package, allow_unicode=True).encode()
    before = await row_counts(engine)

    checked = await world.agents.import_package(data, dry_run=True, by=world.author)
    assert [(one.agent_id, one.action, one.problems) for one in checked.agents] == [
        ("director", "create", []),
        ("helper", "create", []),
    ]
    assert await row_counts(engine) == before

    broken = {
        **package,
        "agents": {
            "director": {
                "name": "导演",
                "config": {
                    "schema_version": 1,
                    "model": {"provider": "nobody", "name": MODEL},
                    "subagents": [{"agent": "ghost"}],
                    "colour": "red",
                },
                "skills": ["no-such-skill"],
            }
        },
    }
    report = await world.agents.import_package(
        yaml.safe_dump(broken, allow_unicode=True).encode(), dry_run=True, by=world.author
    )
    (item,) = report.agents
    assert {one.path for one in item.problems} == {"config.colour", "skills[0]"}
    with pytest.raises(ValidationFailed):
        await world.agents.import_package(
            yaml.safe_dump(broken, allow_unicode=True).encode(), dry_run=False, by=world.author
        )
    assert await row_counts(engine) == before

    wrong_refs = {
        **package,
        "agents": {
            "director": {
                "name": "导演",
                "config": {
                    "schema_version": 1,
                    "model": {"provider": "nobody", "name": MODEL},
                    "subagents": [{"agent": "ghost"}],
                },
            }
        },
    }
    report = await world.agents.import_package(
        yaml.safe_dump(wrong_refs, allow_unicode=True).encode(), dry_run=True, by=world.author
    )
    assert {one.path for one in report.agents[0].problems} == {
        "config.model.provider",
        "config.subagents[0].agent",
    }

    newer = {**package, "format_version": "2.0.0"}
    report = await world.agents.import_package(
        yaml.safe_dump(newer, allow_unicode=True).encode(), dry_run=True, by=world.author
    )
    assert [one.path for one in report.problems] == ["format_version"]

    await world.agents.import_package(data, dry_run=False, by=world.author)
    assert (await world.agents.detail("director")).active_version is None
    assert await operations(engine, "director") == ["import"]


async def test_overwrite_import_only_touches_the_draft(world: World, engine: AsyncEngine) -> None:
    first = await ready_agent(world, "director", instructions="库里的")
    before = await world.agents.detail("director")
    package = {
        "format_version": "1.0.0",
        "entry": "director",
        "agents": {
            "director": {
                "name": "包里的名字",
                "description": "包里的描述",
                "listed": True,
                "config": {
                    "schema_version": 1,
                    "instructions": "包里的",
                    "model": {"provider": world.provider, "name": OTHER_MODEL},
                },
            }
        },
    }

    await world.agents.import_package(
        yaml.safe_dump(package, allow_unicode=True).encode(), dry_run=False, by=world.author
    )

    after = await world.agents.detail("director")
    assert (after.name, after.description, after.listed) == (
        before.name,
        before.description,
        before.listed,
    )
    assert after.active_version is not None and after.active_version.id == first
    assert after.draft.config.instructions == "包里的"
    assert after.draft.skill_ids == []
    assert after.draft.lock_version == before.draft.lock_version + 1
    assert after.draft.base_version_id is None
    assert after.has_unpublished_changes is True
    assert (await operations(engine, "director"))[-1] == "import"


async def test_export_needs_a_published_version(world: World) -> None:
    await new_agent(world, "director")

    with pytest.raises(NotFound):
        await world.agents.export("director")


async def test_skill_in_use_cannot_be_archived_until_only_old_versions_use_it(
    world: World,
) -> None:
    await ready_agent(world, "director")
    with pytest.raises(Conflict, match="director"):
        await world.skills.archive(world.skill_id)
    assert [one.agent_id for one in (await world.skills.detail(world.skill_id)).used_by] == [
        "director"
    ]

    await save(world, "director", config(world), [])
    with pytest.raises(Conflict):
        await world.skills.archive(world.skill_id)
    await publish(world, "director")

    archived = await world.skills.archive(world.skill_id)
    assert archived.status == "archived" and archived.used_by == []


async def test_model_in_use_cannot_be_disabled_until_only_old_versions_use_it(
    world: World,
) -> None:
    await ready_agent(world, "director")
    with pytest.raises(Conflict, match="director"):
        await world.providers.update_model(
            world.provider_id, "llm", MODEL, ModelUpdateIn(enabled=False)
        )
    (provider,) = (await world.providers.providers()).providers
    model = next(one for one in provider.models if one.name == MODEL)
    assert [(one.agent_id, one.in_draft, one.in_active_version) for one in model.used_by] == [
        ("director", True, True)
    ]

    await save(
        world, "director", config(world, model={"provider": world.provider, "name": OTHER_MODEL})
    )
    with pytest.raises(Conflict):
        await world.providers.update_model(
            world.provider_id, "llm", MODEL, ModelUpdateIn(enabled=False)
        )
    await publish(world, "director")

    disabled = await world.providers.update_model(
        world.provider_id, "llm", MODEL, ModelUpdateIn(enabled=False)
    )
    assert disabled.enabled is False


async def test_custom_model_in_use_cannot_be_deleted(world: World) -> None:
    await world.providers.add_model(
        world.provider_id, CustomModelCreateIn(name="qwen-max", type="llm", api="chat")
    )
    await new_agent(world, "director")
    await save(
        world, "director", config(world, model={"provider": world.provider, "name": "qwen-max"})
    )

    with pytest.raises(Conflict):
        await world.providers.delete_model(world.provider_id, "llm", "qwen-max")


async def test_credential_in_use_cannot_be_deleted_until_only_old_versions_use_it(
    world: World,
) -> None:
    pinned = {"provider": world.provider, "name": MODEL, "credential_id": str(world.spare_key)}
    await ready_agent(world, "director", model=pinned)
    with pytest.raises(Conflict, match="director"):
        await world.providers.delete_credential(world.provider_id, world.spare_key)
    (provider,) = (await world.providers.providers()).providers
    spare = next(one for one in provider.credentials if one.id == world.spare_key)
    assert [one.agent_id for one in spare.used_by] == ["director"]

    await save(world, "director", config(world), [world.skill_id])
    await publish(world, "director")

    await world.providers.delete_credential(world.provider_id, world.spare_key)


async def test_provider_in_use_cannot_be_disabled_until_only_old_versions_use_it(
    world: World,
) -> None:
    await ready_agent(world, "director")
    with pytest.raises(Conflict, match="director"):
        await world.providers.update(world.provider_id, ModelProviderUpdateIn(enabled=False))

    # 草稿不再写它，当前版本还写着，照样拦。
    await save(world, "director", AgentConfig(schema_version=1), [])
    with pytest.raises(Conflict):
        await world.providers.update(world.provider_id, ModelProviderUpdateIn(enabled=False))
    other = await world.providers.create(
        ModelProviderCreateIn(name="bailian-backup", provider="bailian", label="百炼备用")
    )
    await world.providers.create_credential(
        other.id,
        CredentialCreateIn(name="主账号", fields={"api_key": GOOD_KEY}),
        created_by=world.author,
    )
    await save(world, "director", config(world, model={"provider": other.name, "name": MODEL}))
    await publish(world, "director")

    paused = await world.providers.update(world.provider_id, ModelProviderUpdateIn(enabled=False))
    assert paused.enabled is False
