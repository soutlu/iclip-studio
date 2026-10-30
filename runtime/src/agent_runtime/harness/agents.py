"""用 pydantic-ai 原生的 spec 机制装配一个 Agent：插件写成 AgentSpec 的 capabilities 条目，模型、提示词与
StepPersistence、用量台账、技能、子代理这些运行时挂件由调用方递进来。一次装配的结果不可变。"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final, NotRequired, TypedDict

from pydantic_ai import Agent, AgentSpec
from pydantic_ai.capabilities import AbstractCapability, AgentCapability
from pydantic_ai.models import Model
from pydantic_ai.tools import DeferredToolRequests
from pydantic_ai_harness.step_persistence import StepPersistence, StepStore
from pydantic_ai_harness.subagents import SubAgent, SubAgents

from agent_runtime.harness.models import thinking_effort_of
from agent_runtime.transcript.display import AgentCallDisplay, DisplayFn, ToolDisplay

DELEGATE_TOOL = "delegate_task"
"""显式指定 SubAgents 工具名，与 display 注册保持一致。"""

TOOL_RETRIES: Final = 3
"""每件工具在一次运行里的参数纠错次数。

官方默认 1：同一件工具第二次参数出错就抛 UnexpectedModelBehavior 终止整次运行，
一次手滑会作废前面已完成的全部产物。计数按工具名累计、成功一次归零，同一步里并行
失败多次只记一次。output 预算保持默认。"""


class SubAgentProfile(TypedDict):
    """子代理档案：原样写进子运行的 metadata（str→str），实时任务卡与历史都按这几个键读。"""

    agent_name: str
    model: str
    """供应方模型 id。"""
    thinking_effort: NotRequired[str]
    """配了思考档位才有。"""


def subagent_profile(agent_name: str, model: Model) -> SubAgentProfile:
    """一个子代理的档案：名字、模型 id、思考档位。同一份既写进子运行的落库 metadata，也交给镜像标在
    任务上，实时与历史读到的字符串才相同。"""

    profile: SubAgentProfile = {"agent_name": agent_name, "model": model.model_name}
    effort = thinking_effort_of(model)
    if effort is not None:
        profile["thinking_effort"] = effort
    return profile


def profile_metadata(profile: SubAgentProfile) -> dict[str, str]:
    """档案写成子运行的落库 metadata（str→str）。"""

    metadata = {"agent_name": profile["agent_name"], "model": profile["model"]}
    if "thinking_effort" in profile:
        metadata["thinking_effort"] = profile["thinking_effort"]
    return metadata


def build_agent(
    *,
    name: str,
    model: Model,
    instructions: str,
    plugins: Sequence[Mapping[str, Mapping[str, Any]]],
    plugin_types: Sequence[type[AbstractCapability[Any]]],
    step_store: StepStore,
    usage_ledger: AgentCapability[Any],
    run_metadata: Mapping[str, str],
    accepts_deferred: bool,
    extra: Sequence[AgentCapability[Any]] = (),
) -> Agent[Any, Any]:
    """装配一个 Agent。

    ``plugins`` 是原生 AgentSpec 的 capabilities 条目（``{插件名: 参数}``），``plugin_types`` 是插件登记表
    里绑好服务的类，交给 ``custom_capability_types``；插件名不认识、参数不对或少挂了依赖由 pydantic-ai
    在这里抛出。``run_metadata`` 原样写进每次运行的落库记录。

    顶层与子代理都不设 agent_name，落库 run id 与消息 run_id 一致；子代理的名字放 metadata。
    审批工具仅挂顶层 Agent，并通过 ``accepts_deferred`` 启用 DeferredToolRequests。
    StepPersistence.run_id 保持为空，由 for_run 按运行计算，以支持并发复用能力实例。
    用量台账每个 Agent 都挂，同一个实例共用。提示词为空就不注入指令。
    """

    return Agent.from_spec(
        AgentSpec.from_dict({"capabilities": [dict(entry) for entry in plugins]}),
        custom_capability_types=list(plugin_types),
        model=model,
        name=name,
        instructions=instructions.strip() or None,
        output_type=[str, DeferredToolRequests] if accepts_deferred else str,
        retries={"tools": TOOL_RETRIES},
        capabilities=[
            StepPersistence(store=step_store, metadata=dict(run_metadata)),
            usage_ledger,
            *extra,
        ],
    )


@dataclass(frozen=True, slots=True)
class SubAgentSlot:
    """一个子代理：派活工具里的名字、给主 agent 看的描述、装配好的 Agent 与三个控制项。"""

    name: str
    description: str
    agent: Agent[Any, Any]
    timeout_seconds: float | None = None
    max_calls: int | None = None
    on_failure: str | None = None


def build_subagents(
    slots: Sequence[SubAgentSlot], *, mirror: AgentCapability[Any]
) -> SubAgents[Any]:
    """把子代理挂成一件 ``delegate_task``；``mirror`` 是共享给每个子运行的 transcript 镜像。"""

    return SubAgents(
        agents=[
            SubAgent(
                slot.agent,
                name=slot.name,
                description=slot.description or None,
                timeout_seconds=slot.timeout_seconds,
                max_calls=slot.max_calls,
                on_failure=slot.on_failure,
            )
            for slot in slots
        ],
        tool_name=DELEGATE_TOOL,
        # 禁用磁盘扫描，避免个人 .agents/.claude 目录中的 Agent 定义进入运行环境。
        agent_folders=None,
        # 共享的只有 transcript 镜像；业务能力仍按子代理各自声明。
        shared_capabilities=[mirror],
    )


def delegate_display_table() -> Mapping[str, DisplayFn]:
    """从 delegate_task 参数生成子代理工具卡。"""

    return {DELEGATE_TOOL: _delegate_display}


def _delegate_display(args: Any) -> ToolDisplay | None:
    if not isinstance(args, dict):
        return None
    name = args.get("agent_name")
    task = args.get("task")
    if not isinstance(name, str) or not name or not isinstance(task, str):
        return None
    return AgentCallDisplay(agent_name=name, prompt=task)


__all__ = [
    "DELEGATE_TOOL",
    "TOOL_RETRIES",
    "SubAgentProfile",
    "SubAgentSlot",
    "build_agent",
    "build_subagents",
    "delegate_display_table",
    "profile_metadata",
    "subagent_profile",
]
