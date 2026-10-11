"""BackgroundTools 写进消息的回执与结果，与 iclip.harness.background 的解析对得上。

用真 Agent 跑出 harness 实际产出的文本；harness 升级改了措辞，这里先红。
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

import pytest
from pydantic_ai import Agent, ModelRetry, Tool, ToolFailed
from pydantic_ai.messages import (
    INTERRUPTED_TOOL_RETURN_CONTENT,
    ModelMessage,
    ModelRequest,
    ModelResponse,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai.models.function import AgentInfo, FunctionModel

from iclip.harness.background import (
    BackgroundOutcome,
    BackgroundTools,
    interrupt_stale_receipts,
    is_receipt,
    parse_outcome,
)

DOCUMENT = "视频拆解完毕，文档在 references/ref.md。\n第二行"


async def _slow_success() -> str:
    await asyncio.sleep(0.05)
    return DOCUMENT


async def _slow_retry() -> str:
    await asyncio.sleep(0.05)
    raise ModelRetry("拆解失败，再调用一次。")


async def _slow_failed() -> str:
    await asyncio.sleep(0.05)
    raise ToolFailed("拆解失败，不要重试，告诉用户稍后再试。")


async def _run(tool: Tool[Any]) -> list[ModelMessage]:
    """调一次后台工具，拿到回执就结束这一步；harness 等到结果后让模型再答一次。"""

    def script(messages: list[ModelMessage], _info: AgentInfo) -> ModelResponse:
        if len(messages) == 1:
            return ModelResponse(parts=[ToolCallPart(tool.name, {}, tool_call_id="call_bg")])
        return ModelResponse(parts=[TextPart("好")])

    agent = Agent(FunctionModel(script), tools=[tool], capabilities=[BackgroundTools()])
    return (await agent.run("拆一下")).all_messages()


def _parts[T](messages: list[ModelMessage], kind: type[T]) -> list[T]:
    return [
        part
        for message in messages
        if isinstance(message, ModelRequest)
        for part in message.parts
        if isinstance(part, kind)
    ]


@pytest.mark.parametrize(
    ("function", "expected"),
    [
        (_slow_success, BackgroundOutcome("call_bg", "breakdown_video", "done", DOCUMENT)),
        (
            _slow_retry,
            BackgroundOutcome("call_bg", "breakdown_video", "error", "拆解失败，再调用一次。"),
        ),
        (
            _slow_failed,
            BackgroundOutcome(
                "call_bg", "breakdown_video", "error", "拆解失败，不要重试，告诉用户稍后再试。"
            ),
        ),
    ],
)
async def test_the_receipt_and_the_outcome_the_harness_writes_are_recognised(
    function: Callable[[], Awaitable[str]], expected: BackgroundOutcome
) -> None:
    messages = await _run(Tool(function, name="breakdown_video", metadata={"background": True}))

    (receipt,) = _parts(messages, ToolReturnPart)
    assert is_receipt(receipt)
    prompts = _parts(messages, UserPromptPart)
    assert parse_outcome(prompts[0]) is None, "用户自己的话不是结果"
    assert [parse_outcome(part) for part in prompts[1:]] == [expected]


async def test_an_ordinary_return_is_not_a_receipt() -> None:
    messages = await _run(Tool(_slow_success, name="breakdown_video"))

    (returned,) = _parts(messages, ToolReturnPart)
    assert returned.content == DOCUMENT
    assert not is_receipt(returned)


async def test_only_a_receipt_without_an_outcome_is_interrupted() -> None:
    messages = await _run(
        Tool(_slow_success, name="breakdown_video", metadata={"background": True})
    )

    assert interrupt_stale_receipts(messages) == messages

    # 去掉送达结果的那条请求：回执后面再没有结果，就是被停或崩溃时留下的历史。
    dropped = [
        message
        for message in messages
        if not (
            isinstance(message, ModelRequest)
            and any(
                isinstance(part, UserPromptPart) and parse_outcome(part) is not None
                for part in message.parts
            )
        )
    ]
    repaired = interrupt_stale_receipts(dropped)

    (returned,) = _parts(repaired, ToolReturnPart)
    assert (returned.tool_call_id, returned.tool_name, returned.content, returned.outcome) == (
        "call_bg",
        "breakdown_video",
        INTERRUPTED_TOOL_RETURN_CONTENT,
        "interrupted",
    )
