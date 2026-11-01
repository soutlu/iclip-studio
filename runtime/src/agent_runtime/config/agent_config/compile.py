"""把一份配置编译成装配 agent 要用的 ``CompiledAgent``，或者一张问题清单。

先查完全部引用再给结果，不在半路停：模型、插件、MCP 服务、技能、子 agent 各自的问题都列出来，每条带
``path``。跨领域的事实都经端口查（见 ``repository``）；子 agent 用的是本领域自己的 ``AgentRefs``。结果直接
对应 pydantic-ai 的装配：``capabilities`` 是原生 AgentSpec 的条目，MCP 服务、技能与子 agent 单独带着。"""

from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence
from typing import Any

from agent_runtime.config.agent_config.config import (
    AgentConfig,
    AgentModelRef,
    CapToolConfig,
    McpToolConfig,
    SubagentConfig,
    ToolConfig,
)
from agent_runtime.config.agent_config.models import (
    MCP_TOOL_NAME_PATTERN,
    STATUS_ARCHIVED,
    AgentRefs,
    CompiledAgent,
    CompiledMcpServer,
    CompiledModel,
    CompiledSkill,
    CompiledSubagent,
    McpServerFacts,
    Problem,
    SkillFacts,
    mcp_tool_name,
    mcp_tool_prefix,
)
from agent_runtime.config.agent_config.repository import (
    McpDirectory,
    ModelDirectory,
    PluginDirectory,
)


async def compile_agent(
    agent_id: str,
    config: AgentConfig,
    skill_ids: Sequence[uuid.UUID],
    *,
    models: ModelDirectory,
    plugins: PluginDirectory,
    mcp: McpDirectory,
    skills: Sequence[SkillFacts],
    agents: Sequence[AgentRefs],
    runtime: bool = False,
) -> CompiledAgent | tuple[Problem, ...]:
    """``skills`` 是技能库的全部技能，``agents`` 是全部 agent 的引用（含 ``agent_id`` 自己）。

    ``runtime`` 为真是运行前装配一个已定下的配置（对话固定的版本，或草稿）：子 agent 只有一层的规则只看
    各 agent 的当前版本，不看草稿，也不查「自己正被别人当作子 agent」——别人草稿里的改动不该让已经定下的
    版本跑不起来；MCP 服务只查在不在、启没启用，不拿最后一次发现的工具对照（见 ``_compile_mcp``）。其余规则
    与发布一样。"""

    problems: list[Problem] = []
    model = await _compile_model(config.model, models, problems)
    capabilities, mcp_servers = await _compile_tools(
        config.tools, plugins, mcp, problems, runtime=runtime
    )
    compiled_skills = _compile_skills(skill_ids, skills, problems)
    subagents = _compile_subagents(agent_id, config.subagents, agents, problems, runtime=runtime)
    if problems or model is None:
        return tuple(problems)
    return CompiledAgent(
        agent_id=agent_id,
        instructions=config.instructions,
        model=model,
        capabilities=capabilities,
        mcp_servers=mcp_servers,
        skills=compiled_skills,
        subagents=subagents,
    )


async def _compile_model(
    ref: AgentModelRef | None, models: ModelDirectory, problems: list[Problem]
) -> CompiledModel | None:
    if ref is None:
        problems.append(Problem("model", "请选择模型"))
        return None
    provider = await models.provider(ref.provider)
    if provider is None:
        problems.append(Problem("model.provider", f"没有引用名为 {ref.provider} 的供应商"))
        return None
    found = len(problems)
    if not provider.enabled:
        problems.append(Problem("model.provider", f"供应商 {ref.provider} 已停用"))
    model = next((one for one in provider.models if one.name == ref.name), None)
    if model is None:
        problems.append(
            Problem("model.name", f"供应商 {ref.provider} 没有叫 {ref.name} 的对话模型")
        )
    elif not model.enabled:
        problems.append(Problem("model.name", f"模型 {ref.name} 已停用"))
    thinking = ref.settings.thinking
    if model is not None and thinking is not None and thinking not in model.thinking:
        allowed = "、".join(model.thinking)
        problems.append(
            Problem(
                "model.settings.thinking",
                f"{ref.name} 只能设这些思考档位：{allowed}"
                if allowed
                else f"{ref.name} 不能设思考档位",
            )
        )
    credential_id = ref.credential_id
    if credential_id is not None and credential_id not in provider.credential_ids:
        problems.append(Problem("model.credential_id", f"这把密钥不是供应商 {ref.provider} 的"))
    if credential_id is None:
        credential_id = provider.default_credential_id
        if credential_id is None:
            problems.append(
                Problem(
                    "model.credential_id", f"供应商 {ref.provider} 还没有默认密钥，请先加一把密钥"
                )
            )
    if len(problems) > found or credential_id is None:
        return None
    return CompiledModel(
        provider_id=provider.id,
        provider=provider.name,
        model=ref.name,
        credential_id=credential_id,
        thinking=thinking,
    )


async def _compile_tools(
    tools: Sequence[ToolConfig],
    plugins: PluginDirectory,
    mcp: McpDirectory,
    problems: list[Problem],
    *,
    runtime: bool,
) -> tuple[tuple[Mapping[str, Mapping[str, Any]], ...], tuple[CompiledMcpServer, ...]]:
    enabled = {tool.toolset for tool in tools if isinstance(tool, CapToolConfig) and tool.enabled}
    entries: list[Mapping[str, Mapping[str, Any]]] = []
    servers: list[CompiledMcpServer] = []
    for index, tool in enumerate(tools):
        if isinstance(tool, McpToolConfig):
            server = await _compile_mcp(index, tool, mcp, problems, runtime=runtime)
            if server is not None:
                servers.append(server)
            continue
        if not tool.enabled:
            continue
        entry = _compile_cap(index, tool, enabled, plugins, problems)
        if entry is not None:
            entries.append(entry)
    return tuple(entries), tuple(servers)


async def _compile_mcp(
    index: int,
    tool: McpToolConfig,
    mcp: McpDirectory,
    problems: list[Problem],
    *,
    runtime: bool,
) -> CompiledMcpServer | None:
    """MCP 服务要在、要启用；发布时另查选的工具都在最后一次发现的工具里、加上前缀后模型收得下。运行时只查
    前两条：工具的增减以服务当下交出的为准，原生的 ``allowed_tools`` 只放行写了的那几个。"""

    path = f"tools[{index}]"
    server = await mcp.server(tool.server)
    if server is None:
        problems.append(Problem(f"{path}.server", f"没有标识为 {tool.server} 的 MCP 服务"))
        return None
    found = len(problems)
    if not server.enabled:
        problems.append(Problem(f"{path}.server", f"MCP 服务 {server.name} 已停用"))
    if not runtime:
        _check_mcp_tools(path, tool, server, problems)
    if len(problems) > found:
        return None
    return CompiledMcpServer(
        server_id=server.id, tools=tool.tools, tool_prefix=mcp_tool_prefix(server.id)
    )


def _check_mcp_tools(
    path: str, tool: McpToolConfig, server: McpServerFacts, problems: list[Problem]
) -> None:
    discovered = server.tools
    if discovered is None:
        problems.append(
            Problem(f"{path}.server", f"MCP 服务 {server.name} 还没有连通过，先测试连接再发布")
        )
        return
    if tool.tools is None:
        for name in discovered:
            if (message := _exposed_name_problem(server.id, name)) is not None:
                problems.append(Problem(path, message))
        return
    for position, name in enumerate(tool.tools):
        tool_path = f"{path}.tools[{position}]"
        if name not in discovered:
            problems.append(Problem(tool_path, f"MCP 服务 {server.name} 没有工具 {name}"))
        elif (message := _exposed_name_problem(server.id, name)) is not None:
            problems.append(Problem(tool_path, message))


def _exposed_name_problem(server_id: str, tool: str) -> str | None:
    """模型看到的工具名不合写法时给人看的原因，合格给 ``None``。"""

    exposed = mcp_tool_name(server_id, tool)
    if MCP_TOOL_NAME_PATTERN.fullmatch(exposed) is not None:
        return None
    return (
        f"工具 {tool} 在 agent 里叫 {exposed}，模型只收字母、数字、下划线与连字符，最多 64 个字符；"
        f"「mcp_」、服务标识、「_」与工具名合起来超了或含有别的字符，换一个短一些的服务标识，"
        "或不选这个工具"
    )


def _compile_cap(
    index: int,
    tool: CapToolConfig,
    enabled: set[str],
    plugins: PluginDirectory,
    problems: list[Problem],
) -> Mapping[str, Mapping[str, Any]] | None:
    """插件编译成 ``{插件名: 参数}``，插件名就是它的 spec 名。"""

    path = f"tools[{index}]"
    if tool.toolset not in plugins.available():
        problems.append(Problem(path, f"本部署没有插件 {tool.toolset}"))
        return None
    found = len(problems)
    problems.extend(
        Problem(f"{path}.parameters{_suffix(one.path)}", one.message)
        for one in plugins.parameter_problems(tool.toolset, tool.parameters)
    )
    missing = [name for name in plugins.requires(tool.toolset) if name not in enabled]
    if missing:
        problems.append(Problem(path, f"插件 {tool.toolset} 要求同时启用 {'、'.join(missing)}"))
    if len(problems) > found:
        return None
    return {tool.toolset: dict(tool.parameters)}


def _suffix(path: str) -> str:
    if not path:
        return ""
    return path if path.startswith("[") else f".{path}"


def _compile_skills(
    skill_ids: Sequence[uuid.UUID], skills: Sequence[SkillFacts], problems: list[Problem]
) -> tuple[CompiledSkill, ...]:
    by_id = {skill.id: skill for skill in skills}
    compiled: list[CompiledSkill] = []
    for index, skill_id in enumerate(skill_ids):
        path = f"skills[{index}]"
        skill = by_id.get(skill_id)
        if skill is None:
            problems.append(Problem(path, "技能不存在"))
        elif skill.archived:
            problems.append(Problem(path, f"技能 {skill.name} 已归档"))
        elif skill.latest_version_id is None:
            problems.append(Problem(path, f"技能 {skill.name} 还没有发布过版本"))
        else:
            compiled.append(
                CompiledSkill(
                    skill_id=skill.id, name=skill.name, version_id=skill.latest_version_id
                )
            )
    return tuple(compiled)


def _compile_subagents(
    agent_id: str,
    subagents: Sequence[SubagentConfig],
    agents: Sequence[AgentRefs],
    problems: list[Problem],
    *,
    runtime: bool,
) -> tuple[CompiledSubagent, ...]:
    by_id = {one.agent_id: one for one in agents}
    subagents_of = _active_subagents_of if runtime else _subagents_of
    if subagents and not runtime:
        referrers = sorted(
            one.agent_id for one in agents if one.agent_id != agent_id and agent_id in one.subagents
        )
        if referrers:
            problems.append(
                Problem(
                    "subagents",
                    f"这个 agent 正被 {'、'.join(referrers)} 当作子 agent，子 agent 只能有一层，"
                    "它自己不能再有子 agent",
                )
            )
    compiled: list[CompiledSubagent] = []
    for index, sub in enumerate(subagents):
        path = f"subagents[{index}].agent"
        target = by_id.get(sub.agent)
        if sub.agent == agent_id:
            problems.append(Problem(path, "不能把自己当作子 agent"))
        elif target is None:
            problems.append(Problem(path, f"没有标识为 {sub.agent} 的 agent"))
        elif target.status == STATUS_ARCHIVED:
            problems.append(Problem(path, f"{target.name} 已归档"))
        elif target.active_version_id is None:
            problems.append(Problem(path, f"{target.name} 还没有发布过版本"))
        elif subagents_of(target):
            problems.append(Problem(path, f"{target.name} 自己有子 agent，子 agent 只能有一层"))
        else:
            compiled.append(
                CompiledSubagent(
                    agent_id=target.agent_id,
                    description=target.description,
                    version_id=target.active_version_id,
                    timeout_seconds=sub.timeout_seconds,
                    max_calls=sub.max_calls,
                    on_failure=sub.on_failure,
                )
            )
    return tuple(compiled)


def _subagents_of(refs: AgentRefs) -> frozenset[str]:
    return refs.subagents


def _active_subagents_of(refs: AgentRefs) -> frozenset[str]:
    """只看当前版本里写的子 agent：运行时装配的是当前版本。"""

    return frozenset(refs.active.subagents if refs.active is not None else ())


__all__ = ["compile_agent"]
