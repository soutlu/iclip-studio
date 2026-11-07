from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Mapping, Sequence
from typing import Any

from pydantic_ai.capabilities import AgentCapability, Capability
from pydantic_ai.messages import (
    ModelMessage,
    ToolReturnPart,
)
from pydantic_ai.models import Model
from pydantic_ai.models.function import AgentInfo, DeltaToolCall, DeltaToolCalls, FunctionModel
from pydantic_ai.models.test import TestModel
from pydantic_ai_harness.step_persistence import InMemoryStepStore

from cue.harness.agents import (
    DELEGATE_TOOL,
    SubAgentSlot,
    build_agent,
    build_subagents,
    profile_metadata,
    subagent_profile,
)
from cue.harness.transcript.store import TranscriptStore
from cue.harness.transcript.subagents import SubAgentMirror
from tests.helpers.runtime import discarding_usage_ledger

WRITER = "shot-writer"


def make_agent(
    name: str,
    model: Model,
    *,
    extra: Sequence[AgentCapability[Any]] = (),
    step_store: InMemoryStepStore | None = None,
    accepts_deferred: bool = True,
    run_metadata: Mapping[str, str] | None = None,
) -> Any:
    return build_agent(
        name=name,
        model=model,
        instructions="",
        plugins=(),
        plugin_types=(),
        step_store=step_store or InMemoryStepStore(),
        usage_ledger=discarding_usage_ledger(),
        run_metadata=run_metadata or {},
        accepts_deferred=accepts_deferred,
        extra=extra,
    )


def producer_with_writer(
    parent: Model,
    child: Model,
    *,
    step_store: InMemoryStepStore | None = None,
    parent_extra: Sequence[AgentCapability[Any]] = (),
    child_extra: Sequence[AgentCapability[Any]] = (),
    max_calls: int | None = None,
    timeout_seconds: float | None = None,
) -> Any:
    stored = step_store or InMemoryStepStore()
    profile = subagent_profile(WRITER, child)
    writer = make_agent(
        WRITER,
        child,
        extra=child_extra,
        step_store=stored,
        accepts_deferred=False,
        run_metadata=profile_metadata(profile),
    )
    delegate = build_subagents(
        [
            SubAgentSlot(
                name=WRITER,
                description="",
                agent=writer,
                max_calls=max_calls,
                timeout_seconds=timeout_seconds,
            )
        ],
        mirror=SubAgentMirror(live=TranscriptStore(), profiles={WRITER: profile}),
    )
    return make_agent(
        "producer",
        parent,
        extra=[*parent_extra, delegate],
        step_store=stored,
    )


async def drive(agent: Any) -> None:
    async with agent.run_stream_events("hi", conversation_id="c1", run_id="run-1") as events:
        async for _event in events:
            pass


def _delegate_to_writer() -> DeltaToolCalls:
    return {
        0: DeltaToolCall(
            name=DELEGATE_TOOL,
            json_args=json.dumps({"agent_name": WRITER, "task": "写三个镜头"}, ensure_ascii=False),
        )
    }


async def _delegate_once(
    messages: list[ModelMessage], _info: AgentInfo
) -> AsyncIterator[str | DeltaToolCalls]:
    if len(messages) == 1:
        yield _delegate_to_writer()
    else:
        yield "done"


async def _child_done(_messages: list[ModelMessage], _info: AgentInfo) -> AsyncIterator[str]:
    yield "done"


async def test_runs_record_the_given_metadata_for_parent_and_subagent() -> None:
    step_store = InMemoryStepStore()
    profile_model = FunctionModel(stream_function=_child_done, model_name="child-m")
    stored = producer_with_writer(
        FunctionModel(stream_function=_delegate_once), profile_model, step_store=step_store
    )

    await drive(stored)

    runs = await step_store.list_runs()
    assert [run.run_id for run in runs] == ["run-1", runs[1].run_id]
    assert dict(runs[1].metadata) == {"agent_name": WRITER, "model": "child-m"}
    assert runs[0].conversation_id == "c1"
    assert runs[1].parent_run_id == runs[0].run_id

    top_store = InMemoryStepStore()
    top = make_agent(
        "storyboard",
        TestModel(),
        step_store=top_store,
        run_metadata={"agent_version_id": "v-1", "model": "test"},
    )
    await drive(top)
    (run,) = await top_store.list_runs()
    assert dict(run.metadata) == {"agent_version_id": "v-1", "model": "test"}


async def test_subagent_only_gets_the_capabilities_declared_for_it() -> None:
    def parent_only_tool() -> str:
        return "父"

    def child_only_tool() -> str:
        return "子"

    seen: dict[str, tuple[str, ...]] = {}

    async def parent_delegates(
        messages: list[ModelMessage], info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        if len(messages) == 1:
            seen["parent"] = tuple(tool.name for tool in info.function_tools)
            yield _delegate_to_writer()
        else:
            yield "done"

    async def child_records(_messages: list[ModelMessage], info: AgentInfo) -> AsyncIterator[str]:
        seen["child"] = tuple(tool.name for tool in info.function_tools)
        yield "done"

    agent = producer_with_writer(
        FunctionModel(stream_function=parent_delegates),
        FunctionModel(stream_function=child_records),
        parent_extra=[Capability[Any](id="parent-pack", tools=[parent_only_tool])],
        child_extra=[Capability[Any](id="child-pack", tools=[child_only_tool])],
    )

    await drive(agent)

    assert "parent_only_tool" in seen["parent"] and DELEGATE_TOOL in seen["parent"]
    assert "child_only_tool" not in seen["parent"]
    assert seen["child"] == ("child_only_tool",)


CHILD_OUTPUT = "三个镜头写好了"


def _delegate_returns(messages: list[ModelMessage]) -> list[Any]:
    return [
        part.content
        for message in messages
        for part in message.parts
        if isinstance(part, ToolReturnPart) and part.tool_name == DELEGATE_TOOL
    ]


async def test_a_delegation_past_max_calls_does_not_run_the_subagent() -> None:
    seen: list[Any] = []

    async def parent_delegates_twice(
        messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        returned = _delegate_returns(messages)
        if len(returned) < 2:
            yield _delegate_to_writer()
        else:
            seen.extend(returned)
            yield "done"

    async def child_answers(_messages: list[ModelMessage], _info: AgentInfo) -> AsyncIterator[str]:
        yield CHILD_OUTPUT

    step_store = InMemoryStepStore()
    agent = producer_with_writer(
        FunctionModel(stream_function=parent_delegates_twice),
        FunctionModel(stream_function=child_answers),
        step_store=step_store,
        max_calls=1,
    )

    await drive(agent)

    child_runs = [run for run in await step_store.list_runs() if run.parent_run_id is not None]
    assert len(child_runs) == 1
    first, second = seen
    assert first == CHILD_OUTPUT
    assert second != CHILD_OUTPUT


async def test_a_subagent_past_its_timeout_is_cut_off() -> None:
    seen: list[Any] = []

    async def parent_delegates_once(
        messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        returned = _delegate_returns(messages)
        if not returned:
            yield _delegate_to_writer()
        else:
            seen.extend(returned)
            yield "done"

    async def child_never_answers(
        _messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str]:
        await asyncio.Event().wait()
        yield CHILD_OUTPUT

    agent = producer_with_writer(
        FunctionModel(stream_function=parent_delegates_once),
        FunctionModel(stream_function=child_never_answers),
        timeout_seconds=0.05,
    )

    async with asyncio.timeout(10):
        await drive(agent)

    assert len(seen) == 1
