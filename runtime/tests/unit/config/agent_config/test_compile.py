"""编译：通过时交回对应 pydantic-ai 装配的结果；模型、档位、密钥、插件、技能与子 agent 的每条规则不过时
交回带 path 的问题，且一次列全。"""

from __future__ import annotations

import uuid
from dataclasses import replace
from typing import Any

from agent_runtime.config.agent_config.compile import compile_agent
from agent_runtime.config.agent_config.config import AgentConfig
from agent_runtime.config.agent_config.models import (
    AgentRefs,
    CompiledAgent,
    CompiledMcpServer,
    ConfigRefs,
    McpServerFacts,
    ModelFacts,
    Problem,
    ProviderFacts,
    SkillFacts,
)
from tests.helpers.agent_config import NOTES, SEARCH, FakePlugins

KEY = uuid.uuid4()
OTHER_KEY = uuid.uuid4()
PROVIDER = ProviderFacts(
    id=uuid.uuid4(),
    name="acme",
    enabled=True,
    credential_ids=frozenset({KEY, OTHER_KEY}),
    default_credential_id=KEY,
    models=(
        ModelFacts(name="m1", enabled=True, thinking=("none", "high")),
        ModelFacts(name="plain", enabled=True, thinking=()),
        ModelFacts(name="old", enabled=False, thinking=()),
    ),
)
SKILL = SkillFacts(id=uuid.uuid4(), name="pdf", archived=False, latest_version_id=uuid.uuid4())


CALC = McpServerFacts(id="calc", name="计算器", enabled=True, tools=("add", "divide"))


class FakeModels:
    def __init__(self, *providers: ProviderFacts) -> None:
        self._providers = {one.name: one for one in providers}

    async def provider(self, name: str) -> ProviderFacts | None:
        return self._providers.get(name)


class FakeMcp:
    def __init__(self, *servers: McpServerFacts) -> None:
        self._servers = {one.id: one for one in servers}

    async def server(self, server_id: str) -> McpServerFacts | None:
        return self._servers.get(server_id)


def refs(
    agent_id: str,
    *,
    draft_subagents: tuple[str, ...] = (),
    active_subagents: tuple[str, ...] | None = (),
    status: str = "active",
) -> AgentRefs:
    def config_refs(subagents: tuple[str, ...]) -> ConfigRefs:
        return ConfigRefs(
            provider=None,
            model=None,
            credential_id=None,
            skill_ids=(),
            subagents=subagents,
            mcp_servers=(),
        )

    return AgentRefs(
        agent_id=agent_id,
        name=agent_id.upper(),
        description=f"{agent_id} 的说明",
        status="archived" if status == "archived" else "active",
        active_version_id=uuid.uuid4() if active_subagents is not None else None,
        draft=config_refs(draft_subagents),
        active=config_refs(active_subagents) if active_subagents is not None else None,
    )


def config(**fields: Any) -> AgentConfig:
    return AgentConfig.model_validate(
        {"schema_version": 1, "model": {"provider": "acme", "name": "m1"}, **fields}
    )


async def compile_(
    agent_config: AgentConfig,
    *,
    skill_ids: tuple[uuid.UUID, ...] = (),
    skills: tuple[SkillFacts, ...] = (SKILL,),
    agents: tuple[AgentRefs, ...] = (),
    providers: tuple[ProviderFacts, ...] = (PROVIDER,),
    mcp_servers: tuple[McpServerFacts, ...] = (CALC,),
    runtime: bool = False,
) -> CompiledAgent | tuple[Problem, ...]:
    return await compile_agent(
        "main",
        agent_config,
        skill_ids,
        models=FakeModels(*providers),
        plugins=FakePlugins(),
        mcp=FakeMcp(*mcp_servers),
        skills=skills,
        agents=(refs("main"), *agents),
        runtime=runtime,
    )


async def problems(agent_config: AgentConfig, **kwargs: Any) -> dict[str, str]:
    result = await compile_(agent_config, **kwargs)
    assert not isinstance(result, CompiledAgent), result
    return {one.path: one.message for one in result}


async def test_missing_or_disabled_provider() -> None:
    assert set(await problems(config(model={"provider": "nobody", "name": "m1"}))) == {
        "model.provider"
    }
    disabled = replace(PROVIDER, enabled=False)
    assert set(await problems(config(), providers=(disabled,))) == {"model.provider"}


async def test_missing_or_disabled_model() -> None:
    assert set(await problems(config(model={"provider": "acme", "name": "nope"}))) == {"model.name"}
    assert set(await problems(config(model={"provider": "acme", "name": "old"}))) == {"model.name"}


async def test_thinking_must_be_allowed_by_the_model() -> None:
    found = await problems(
        config(model={"provider": "acme", "name": "m1", "settings": {"thinking": "max"}})
    )
    assert set(found) == {"model.settings.thinking"}
    assert "none、high" in found["model.settings.thinking"]
    assert set(
        await problems(
            config(model={"provider": "acme", "name": "plain", "settings": {"thinking": "low"}})
        )
    ) == {"model.settings.thinking"}


async def test_credential_must_belong_to_the_provider_or_default_must_exist() -> None:
    assert set(
        await problems(
            config(model={"provider": "acme", "name": "m1", "credential_id": str(uuid.uuid4())})
        )
    ) == {"model.credential_id"}
    keyless = replace(PROVIDER, default_credential_id=None)
    assert set(await problems(config(), providers=(keyless,))) == {"model.credential_id"}


async def test_disabled_unregistered_plugin_is_skipped() -> None:
    result = await compile_(
        config(tools=[{"type": "cap", "toolset": "not-registered", "enabled": False}])
    )

    assert isinstance(result, CompiledAgent)
    assert result.capabilities == ()


async def test_plugin_parameters_are_checked_by_the_plugin() -> None:
    found = await problems(
        config(
            tools=[{"type": "cap", "toolset": NOTES, "parameters": {"limit": 0, "colour": "red"}}]
        )
    )

    assert set(found) == {"tools[0].parameters.limit", "tools[0].parameters.colour"}


async def test_required_plugin_must_be_enabled() -> None:
    missing = await problems(config(tools=[{"type": "cap", "toolset": SEARCH}]))
    disabled = await problems(
        config(
            tools=[
                {"type": "cap", "toolset": NOTES, "enabled": False},
                {"type": "cap", "toolset": SEARCH},
            ]
        )
    )

    assert set(missing) == {"tools[0]"} and NOTES in missing["tools[0]"]
    assert set(disabled) == {"tools[1]"}


async def test_skills_must_exist_be_active_and_published() -> None:
    archived = SkillFacts(
        id=uuid.uuid4(), name="old", archived=True, latest_version_id=uuid.uuid4()
    )
    draft_only = SkillFacts(id=uuid.uuid4(), name="new", archived=False, latest_version_id=None)
    found = await problems(
        config(),
        skill_ids=(SKILL.id, archived.id, draft_only.id, uuid.uuid4()),
        skills=(SKILL, archived, draft_only),
    )

    assert set(found) == {"skills[1]", "skills[2]", "skills[3]"}
    assert "归档" in found["skills[1]"]


async def test_subagent_cannot_be_itself_missing_archived_or_unpublished() -> None:
    found = await problems(
        config(
            subagents=[
                {"agent": "main"},
                {"agent": "ghost"},
                {"agent": "retired"},
                {"agent": "fresh"},
            ]
        ),
        agents=(refs("retired", status="archived"), refs("fresh", active_subagents=None)),
    )

    assert set(found) == {
        "subagents[0].agent",
        "subagents[1].agent",
        "subagents[2].agent",
        "subagents[3].agent",
    }


async def test_subagent_with_its_own_subagents_is_refused() -> None:
    in_active = refs("lead", active_subagents=("worker",))
    in_draft = refs("planner", draft_subagents=("worker",))
    found = await problems(
        config(subagents=[{"agent": "lead"}, {"agent": "planner"}]),
        agents=(in_active, in_draft, refs("worker")),
    )

    assert set(found) == {"subagents[0].agent", "subagents[1].agent"}


async def test_agent_used_as_subagent_cannot_have_subagents() -> None:
    boss = refs("boss", active_subagents=("main",))
    found = await problems(config(subagents=[{"agent": "helper"}]), agents=(boss, refs("helper")))

    assert set(found) == {"subagents"}
    assert "boss" in found["subagents"]


async def test_at_runtime_another_agents_draft_does_not_block_a_settled_version() -> None:
    """别人的草稿把 main 当作子 agent：发布时拦下 main 的子 agent，运行已定下的版本时不拦。"""

    referrer = refs("boss", draft_subagents=("main",))
    with_subagent = config(subagents=[{"agent": "helper"}])

    published = await compile_(with_subagent, agents=(referrer, refs("helper")))
    running = await compile_(with_subagent, agents=(referrer, refs("helper")), runtime=True)

    assert not isinstance(published, CompiledAgent)
    assert {one.path for one in published} == {"subagents"}
    assert isinstance(running, CompiledAgent)


async def test_at_runtime_a_subagents_draft_does_not_count() -> None:
    """子 agent 的草稿里加了子 agent、当前版本没有：发布时拦下，运行时按它的当前版本装，不拦。"""

    drafting = refs("helper", draft_subagents=("worker",))
    agents = (drafting, refs("worker"))
    asks_helper = config(subagents=[{"agent": "helper"}])

    published = await compile_(asks_helper, agents=agents)
    running = await compile_(asks_helper, agents=agents, runtime=True)
    nested = await compile_(
        asks_helper,
        agents=(refs("helper", active_subagents=("worker",)), refs("worker")),
        runtime=True,
    )

    assert not isinstance(published, CompiledAgent)
    assert {one.path for one in published} == {"subagents[0].agent"}
    assert isinstance(running, CompiledAgent)
    assert not isinstance(nested, CompiledAgent), "当前版本里有子 agent 运行时也拦"


async def test_mcp_server_compiles_to_allowed_tools_and_a_prefix() -> None:
    result = await compile_(
        config(
            tools=[
                {"type": "cap", "toolset": NOTES},
                {"type": "mcp", "server": "calc", "tools": ["add"]},
            ]
        )
    )

    assert isinstance(result, CompiledAgent)
    assert result.capabilities == ({NOTES: {}},)
    assert result.mcp_servers == (
        CompiledMcpServer(server_id="calc", tools=("add",), tool_prefix="mcp_calc"),
    )


async def test_mcp_server_must_exist_be_enabled_and_have_been_reached() -> None:
    entry = {"type": "mcp", "server": "calc", "tools": None}

    missing = await problems(config(tools=[entry]), mcp_servers=())
    assert set(missing) == {"tools[0].server"}
    disabled = await problems(config(tools=[entry]), mcp_servers=(replace(CALC, enabled=False),))
    assert "已停用" in disabled["tools[0].server"]
    never_reached = await problems(config(tools=[entry]), mcp_servers=(replace(CALC, tools=None),))
    assert "测试连接" in never_reached["tools[0].server"]


async def test_listed_mcp_tools_must_be_among_the_discovered_ones() -> None:
    found = await problems(
        config(tools=[{"type": "mcp", "server": "calc", "tools": ["add", "sqrt", "divide"]}])
    )

    assert set(found) == {"tools[0].tools[1]"}
    assert "sqrt" in found["tools[0].tools[1]"]


async def test_exposed_mcp_tool_names_must_fit_the_model_rules() -> None:
    long_id = "a" * 40
    server = McpServerFacts(
        id=long_id, name="长", enabled=True, tools=("short", "x" * 20, "has.dot")
    )

    listed = await problems(
        config(tools=[{"type": "mcp", "server": long_id, "tools": ["short", "x" * 20]}]),
        mcp_servers=(server,),
    )
    assert set(listed) == {"tools[0].tools[1]"}
    assert "64" in listed["tools[0].tools[1]"]

    everything = await compile_(
        config(tools=[{"type": "mcp", "server": long_id, "tools": None}]), mcp_servers=(server,)
    )
    assert not isinstance(everything, CompiledAgent)
    assert [one.path for one in everything] == ["tools[0]", "tools[0]"]


async def test_at_runtime_mcp_tools_are_not_checked_against_the_last_discovery() -> None:
    entry = {"type": "mcp", "server": "calc", "tools": ["sqrt"]}
    reached_once = replace(CALC, tools=None)

    running = await compile_(config(tools=[entry]), mcp_servers=(reached_once,), runtime=True)
    assert isinstance(running, CompiledAgent)
    assert running.mcp_servers[0].tools == ("sqrt",)

    gone = await compile_(config(tools=[entry]), mcp_servers=(), runtime=True)
    disabled = await compile_(
        config(tools=[entry]), mcp_servers=(replace(CALC, enabled=False),), runtime=True
    )
    assert not isinstance(gone, CompiledAgent)
    assert not isinstance(disabled, CompiledAgent)


async def test_all_problems_are_listed_together() -> None:
    found = await problems(
        config(
            model={"provider": "acme", "name": "old"},
            tools=[{"type": "cap", "toolset": SEARCH}],
            subagents=[{"agent": "ghost"}],
        ),
        skill_ids=(uuid.uuid4(),),
    )

    assert set(found) == {"model.name", "tools[0]", "skills[0]", "subagents[0].agent"}
