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

TOOL_RETRIES: Final = 3


class SubAgentProfile(TypedDict):
    agent_name: str
    model: str
    thinking_effort: NotRequired[str]


def subagent_profile(agent_name: str, model: Model) -> SubAgentProfile:
    profile: SubAgentProfile = {"agent_name": agent_name, "model": model.model_name}
    effort = thinking_effort_of(model)
    if effort is not None:
        profile["thinking_effort"] = effort
    return profile


def profile_metadata(profile: SubAgentProfile) -> dict[str, str]:
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
    name: str
    description: str
    agent: Agent[Any, Any]
    timeout_seconds: float | None = None
    max_calls: int | None = None
    on_failure: str | None = None


def build_subagents(
    slots: Sequence[SubAgentSlot], *, mirror: AgentCapability[Any]
) -> SubAgents[Any]:
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
        agent_folders=None,
        shared_capabilities=[mirror],
    )


def delegate_display_table() -> Mapping[str, DisplayFn]:
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
