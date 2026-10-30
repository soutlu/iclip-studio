"""装配契约：名字即给定的 agent 标识、插件按原生 spec 挂上、子代理显式声明且限额生效、空提示词不注入、
运行记录的 metadata 原样落库。"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import pytest
from pydantic_ai import ModelRetry, RunContext, UnexpectedModelBehavior
from pydantic_ai.capabilities import AgentCapability, Capability
from pydantic_ai.exceptions import UserError
from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    ToolCallPart,
    ToolReturnPart,
)
from pydantic_ai.models import Model
from pydantic_ai.models.function import AgentInfo, DeltaToolCall, DeltaToolCalls, FunctionModel
from pydantic_ai.models.openai import OpenAIChatModelSettings
from pydantic_ai.models.test import TestModel
from pydantic_ai_harness.step_persistence import InMemoryStepStore

from iclip.harness.agents import (
    DELEGATE_TOOL,
    TOOL_RETRIES,
    SubAgentSlot,
    build_agent,
    build_subagents,
    delegate_display_table,
    subagent_profile,
)
from iclip.harness.transcript.store import TranscriptStore
from iclip.harness.transcript.subagents import SubAgentMirror
from iclip.harness.usage_ledger import UsageLedger
from iclip.platform.transcript.display import AgentCallDisplay
from iclip.platform.transcript.ops import StepUsage
from tests.helpers.runtime import discarding_usage_ledger

WRITER = "shot-writer"


@dataclass(frozen=True)
class Caller:
    """测试 deps 类型，验证依赖传递。

    类型须定义在模块级，以便框架解析延迟求值的工具注解。
    """

    label: str


def make_agent(
    name: str,
    model: Model,
    *,
    instructions: str = "",
    extra: Sequence[AgentCapability[Any]] = (),
    step_store: InMemoryStepStore | None = None,
    ledger: UsageLedger | None = None,
    accepts_deferred: bool = True,
    run_metadata: Mapping[str, str] | None = None,
) -> Any:
    return build_agent(
        name=name,
        model=model,
        instructions=instructions,
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
        run_metadata=dict(profile),
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


def _never(_messages: list[ModelMessage], _info: AgentInfo) -> Any:
    raise AssertionError("装配阶段不该调用模型")


def test_subagent_profile_carries_the_model_id_and_thinking_effort() -> None:
    """档案记供应方模型 id；配了思考档位才有 thinking_effort。"""

    thinking = FunctionModel(
        _never,
        model_name="qwen3-max",
        settings=OpenAIChatModelSettings(openai_reasoning_effort="low"),
    )
    plain = FunctionModel(_never, model_name="qwen3-plus")

    assert subagent_profile(WRITER, thinking) == {
        "agent_name": WRITER,
        "model": "qwen3-max",
        "thinking_effort": "low",
    }
    assert subagent_profile("copy", plain) == {"agent_name": "copy", "model": "qwen3-plus"}


def test_the_agent_is_named_by_the_given_id() -> None:
    assert make_agent("storyboard", TestModel()).name == "storyboard"


async def sent_instructions(agent: Any) -> str | None:
    """执行 Agent 并读取模型实际接收的指令。"""

    request = (await agent.run("hi")).all_messages()[0]
    assert isinstance(request, ModelRequest)
    return request.instructions


async def test_instructions_reach_the_model() -> None:
    assert await sent_instructions(make_agent("a", TestModel(), instructions="写镜头表。")) == (
        "写镜头表。"
    )


async def test_blank_instructions_inject_nothing() -> None:
    assert await sent_instructions(make_agent("a", TestModel(), instructions="   \n\n")) is None


def test_an_unknown_plugin_fails_at_assembly() -> None:
    """插件按原生 spec 挂：登记表里没有这个名字就在装配时报错，不悄悄跳过。"""

    with pytest.raises((UserError, ValueError)):
        build_agent(
            name="a",
            model=TestModel(),
            instructions="",
            plugins=({"ghost": {}},),
            plugin_types=(),
            step_store=InMemoryStepStore(),
            usage_ledger=discarding_usage_ledger(),
            run_metadata={},
            accepts_deferred=True,
        )


async def drive(agent: Any, *, deps: object = None) -> list[Any]:
    """通过 run_stream_events 收集完整运行事件。"""

    async with agent.run_stream_events(
        "hi", conversation_id="c1", run_id="run-1", deps=deps
    ) as events:
        return [event async for event in events]


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


def test_the_delegate_tool_has_a_display() -> None:
    """display 注册名须与实际挂载的 DELEGATE_TOOL 一致，避免错误回退到 generic。"""

    drawn = delegate_display_table()[DELEGATE_TOOL]

    assert drawn({"agent_name": WRITER, "task": "写第 3 组"}) == AgentCallDisplay(
        agent_name=WRITER, prompt="写第 3 组"
    )
    assert drawn({"task": "写第 3 组"}) is None


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


async def test_run_deps_reach_the_tool() -> None:
    """通过替身 deps 验证 run_stream_events 到工具 ctx.deps 的传递。"""

    def whoami(ctx: RunContext[Caller]) -> str:
        """报出当前调用方。"""

        return ctx.deps.label

    agent = make_agent(
        "storyboard", TestModel(), extra=[Capability[Any](id="identity", tools=[whoami])]
    )

    events = await drive(agent, deps=Caller("经运行驱动"))
    assert "经运行驱动" in json.dumps([str(event) for event in events], ensure_ascii=False)


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
