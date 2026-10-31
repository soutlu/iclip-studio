"""运行装配的行为：用量和运行 metadata、子代理能力隔离与调用限额、超时和工具重试。"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Mapping, Sequence
from typing import Any

import pytest
from pydantic_ai import ModelRetry, UnexpectedModelBehavior
from pydantic_ai.capabilities import AgentCapability, Capability
from pydantic_ai.messages import (
    ModelMessage,
    ModelResponse,
    ToolCallPart,
    ToolReturnPart,
)
from pydantic_ai.models import Model
from pydantic_ai.models.function import AgentInfo, DeltaToolCall, DeltaToolCalls, FunctionModel
from pydantic_ai.models.test import TestModel
from pydantic_ai_harness.step_persistence import InMemoryStepStore

from agent_runtime.harness.agents import (
    DELEGATE_TOOL,
    TOOL_RETRIES,
    SubAgentSlot,
    build_agent,
    build_subagents,
    profile_metadata,
    subagent_profile,
)
from agent_runtime.harness.transcript.store import TranscriptStore
from agent_runtime.harness.transcript.subagents import SubAgentMirror
from agent_runtime.harness.usage_ledger import UsageLedger
from agent_runtime.transcript.ops import StepUsage
from tests.helpers.runtime import discarding_usage_ledger

WRITER = "shot-writer"


def make_agent(
    name: str,
    model: Model,
    *,
    extra: Sequence[AgentCapability[Any]] = (),
    step_store: InMemoryStepStore | None = None,
    ledger: UsageLedger | None = None,
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
        usage_ledger=ledger or discarding_usage_ledger(),
        run_metadata=run_metadata or {},
        accepts_deferred=accepts_deferred,
        extra=extra,
    )


def producer_with_writer(
    parent: Model,
    child: Model,
    *,
    step_store: InMemoryStepStore | None = None,
    ledger: UsageLedger | None = None,
    parent_extra: Sequence[AgentCapability[Any]] = (),
    child_extra: Sequence[AgentCapability[Any]] = (),
    description: str = "",
    max_calls: int | None = None,
    timeout_seconds: float | None = None,
) -> Any:
    """producer 下挂一个 shot-writer，与运行时装配一样：子代理的落库 metadata 就是它的档案。"""

    stored = step_store or InMemoryStepStore()
    profile = subagent_profile(WRITER, child)
    writer = make_agent(
        WRITER,
        child,
        extra=child_extra,
        step_store=stored,
        ledger=ledger,
        accepts_deferred=False,
        run_metadata=profile_metadata(profile),
    )
    delegate = build_subagents(
        [
            SubAgentSlot(
                name=WRITER,
                description=description,
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
        ledger=ledger,
    )


async def drive(agent: Any) -> None:
    """通过 run_stream_events 跑完一次运行。"""

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


async def test_the_usage_ledger_is_attached_to_the_agent_and_its_subagents() -> None:
    """顶层与子代理各自的模型响应都进同一本台账，模型名取各自的模型。"""

    recorded: list[tuple[str, str]] = []

    class Recording:
        async def add(self, *, conversation_id: str, model_name: str, usage: StepUsage) -> None:
            recorded.append((conversation_id, model_name))

    agent = producer_with_writer(
        FunctionModel(stream_function=_delegate_once, model_name="parent-m"),
        FunctionModel(stream_function=_child_done, model_name="child-m"),
        ledger=UsageLedger(store=Recording(), conversation_of=lambda _deps: "c1"),
    )

    await drive(agent)

    assert sorted(recorded) == [("c1", "child-m"), ("c1", "parent-m"), ("c1", "parent-m")]


async def test_runs_record_the_given_metadata_for_parent_and_subagent() -> None:
    """落库 run_id 与消息 run_id 一致；顶层记装配时给的 metadata，子运行记它的档案。"""

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


async def test_the_subagent_description_is_listed_for_the_parent() -> None:
    """``description`` 进派活工具的说明，主 agent 看得到子 agent 是干什么的。"""

    seen: list[str] = []

    async def parent_records(_messages: list[ModelMessage], info: AgentInfo) -> AsyncIterator[str]:
        seen.extend(
            f"{info.instructions or ''} {tool.description or ''}" for tool in info.function_tools
        )
        yield "done"

    agent = producer_with_writer(
        FunctionModel(stream_function=parent_records),
        FunctionModel(stream_function=_child_done),
        description="按分镜写镜头脚本",
    )

    await drive(agent)

    assert any("按分镜写镜头脚本" in text for text in seen)


async def test_subagent_only_gets_the_capabilities_declared_for_it() -> None:
    """保留 inherit_tools=False，shared_capabilities 只有不带工具的 transcript 镜像。"""

    def parent_only_tool() -> str:
        """只给主 agent 的工具。"""

        return "父"

    def child_only_tool() -> str:
        """只给下属的工具。"""

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
        # 挂了 transcript 镜像的子代理一律走流式，模型须提供 stream_function。
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
    """主 agent 至今收到的委派工具结果；重试提示不算。"""

    return [
        part.content
        for message in messages
        for part in message.parts
        if isinstance(part, ToolReturnPart) and part.tool_name == DELEGATE_TOOL
    ]


async def test_a_delegation_past_max_calls_does_not_run_the_subagent() -> None:
    """max_calls 用完后再委派，子代理不再跑，主 agent 收到的是一条普通工具结果而不是子代理产出。"""

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
    """子代理超过 timeout_seconds 就被撤下，主 agent 收到一条普通工具结果接着往下走。"""

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

    # 子代理永不返回：限时没生效时由这里报错，而不是把用例挂住。
    async with asyncio.timeout(10):
        await drive(agent)

    assert len(seen) == 1


async def test_tools_get_more_than_one_chance_to_correct_their_arguments() -> None:
    """官方默认 1：同一件工具第二次参数出错就终止整次运行，作废前面已完成的产物。"""

    def always_wrong(value: int) -> str:
        """总是要求改参数的工具。"""

        raise ModelRetry(f"value={value} 不对，换一个再来")

    def call_it(_messages: list[ModelMessage], _info: AgentInfo) -> ModelResponse:
        return ModelResponse(parts=[ToolCallPart("always_wrong", {"value": 1}, tool_call_id="c1")])

    agent = make_agent(
        "storyboard",
        FunctionModel(call_it),
        extra=[Capability[Any](id="wrong", tools=[always_wrong])],
    )

    with pytest.raises(UnexpectedModelBehavior, match=f"max retries count of {TOOL_RETRIES}"):
        await agent.run("hi")
