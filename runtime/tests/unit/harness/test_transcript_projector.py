"""投影器自己的规则：端到端跑不出来、只能用手工事件或官方模型解析的协议流钉住的那几条。

真实运行能产出的形状都在 integration_no_llm/agents/test_transcript_scenarios.py 里比两条路。
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Any

import httpx2
from openai import AsyncOpenAI
from pydantic_ai.messages import (
    CompactionPart,
    EnqueuedMessagesEvent,
    FunctionToolCallEvent,
    FunctionToolResultEvent,
    ModelRequest,
    ModelResponse,
    PartDeltaEvent,
    PartEndEvent,
    PartStartEvent,
    TextPart,
    TextPartDelta,
    ThinkingPart,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai.models import ModelRequestParameters
from pydantic_ai.models.openai import OpenAIResponsesModel
from pydantic_ai.providers.alibaba import AlibabaProvider

from agent_runtime.harness.agents import DELEGATE_TOOL, SubAgentProfile, delegate_display_table
from agent_runtime.harness.transcript.from_messages import turns_from_messages
from agent_runtime.harness.transcript.projector import TranscriptEventStream
from agent_runtime.harness.transcript.store import TranscriptStore
from agent_runtime.transcript.display import (
    FileIoDisplay,
    ToolDisplay,
    ToolDisplayEntry,
    ToolDisplayRegistry,
)
from agent_runtime.transcript.ops import (
    MAIN_AGENT_ID,
    AgentRef,
    FrameUpsertOp,
    PromptContent,
    TextContent,
    ThinkingFrame,
    ToolFrame,
    TranscriptStep,
    TranscriptTask,
    TranscriptTurn,
    TurnOrigin,
    TurnUpsertOp,
)
from tests.helpers.transcript import normalize

CONVERSATION = "conv-1"
RUN = "run-a"
PROMPT = "帮我把 README 翻译成英文"
CONTENT: tuple[PromptContent, ...] = (TextContent(text=PROMPT),)
WRITER = "shot-writer"
TASK = "写第 3 组的三个镜头"
CHILD = "child-run-1"
PROFILE: SubAgentProfile = {"agent_name": WRITER, "model": "test-model"}


def _read_display(args: Any) -> ToolDisplay | None:
    path = args.get("path") if isinstance(args, dict) else None
    return FileIoDisplay(operation="read", path=path) if isinstance(path, str) and path else None


DISPLAYS = ToolDisplayRegistry.merged(
    {"Read": ToolDisplayEntry(draw=_read_display, view="file_content")}, delegate_display_table()
)
"""非空注册表，避免两条路同时缺 display 也能相等。"""


def _at(minute: int) -> datetime:
    return datetime(2026, 8, 30, 9, minute, tzinfo=UTC)


def _projector() -> TranscriptEventStream:
    return TranscriptEventStream(turn_id="t1", turn_ordinal=1, content=CONTENT, display=DISPLAYS)


async def _live(
    projector: TranscriptEventStream, events: AsyncIterator[Any]
) -> tuple[TranscriptTurn, ...]:
    store = TranscriptStore()
    async for batch in projector.transform_stream(events):
        store.append(CONVERSATION, MAIN_AGENT_ID, batch)
    return store.subscribe_view(CONVERSATION, MAIN_AGENT_ID).live_turns


def _derived(*messages: Any) -> tuple[TranscriptTurn, ...]:
    return turns_from_messages(list(messages), turn_states={RUN: "completed"}, display=DISPLAYS)


def _shape(turns: tuple[TranscriptTurn, ...]) -> Any:
    """手工事件里没有 AgentRunResultEvent，实时侧补不上用量，其余逐字比。"""

    def strip(value: Any) -> Any:
        if isinstance(value, dict):
            return {key: strip(item) for key, item in value.items() if key != "usage"}
        if isinstance(value, list):
            return [strip(item) for item in value]
        return value

    return strip(normalize(turns))


# --- 只能用手工事件造出来的形状 -------------------------------------------------


async def test_two_adjacent_text_parts_stay_two_frames_on_both_paths() -> None:
    """模型一次响应里连发两段正文是两个块，不并成一段；假模型造不出这个形状。"""

    async def stream() -> AsyncIterator[Any]:
        yield PartStartEvent(index=0, part=TextPart(content=""))
        yield PartDeltaEvent(index=0, delta=TextPartDelta(content_delta="第一段"))
        yield PartEndEvent(index=0, part=TextPart(content="第一段"))
        yield PartStartEvent(index=1, part=TextPart(content=""))
        yield PartDeltaEvent(index=1, delta=TextPartDelta(content_delta="第二段"))
        yield PartEndEvent(index=1, part=TextPart(content="第二段"))

    live = await _live(_projector(), stream())
    derived = _derived(
        ModelRequest(parts=[UserPromptPart(content=PROMPT)], run_id=RUN, timestamp=_at(0)),
        ModelResponse(
            parts=[TextPart(content="第一段"), TextPart(content="第二段")],
            run_id=RUN,
            timestamp=_at(1),
        ),
    )

    assert [frame.frame_id for frame in live[0].steps[0].frames] == ["t1.1.f1", "t1.1.f2"]
    assert _shape(live) == _shape(derived)


async def test_a_compaction_notice_lands_on_the_same_step_on_both_paths() -> None:
    """压缩提示关联之后的第一步：实时等待步骤创建，历史按边界时间定位。"""

    summary = "Summary of previous conversation:\n\n## Intent\n翻 README"
    projector = _projector()

    async def stream() -> AsyncIterator[Any]:
        yield PartStartEvent(index=0, part=TextPart(content=""))
        yield PartDeltaEvent(index=0, delta=TextPartDelta(content_delta="先读"))
        yield PartEndEvent(index=0, part=TextPart(content="先读"))
        yield FunctionToolCallEvent(part=ToolCallPart(tool_name="Read", args={}, tool_call_id="c1"))
        yield FunctionToolResultEvent(
            part=ToolReturnPart(tool_name="Read", content="x", tool_call_id="c1")
        )
        projector.note_compaction(summary, ())
        yield PartStartEvent(index=0, part=TextPart(content=""))
        yield PartDeltaEvent(index=0, delta=TextPartDelta(content_delta="读完了"))
        yield PartEndEvent(index=0, part=TextPart(content="读完了"))

    live = await _live(projector, stream())
    derived = _derived(
        ModelRequest(parts=[UserPromptPart(content=PROMPT)], run_id=RUN, timestamp=_at(0)),
        ModelResponse(
            parts=[
                TextPart(content="先读"),
                ToolCallPart(tool_name="Read", args={}, tool_call_id="c1"),
            ],
            run_id=RUN,
            timestamp=_at(1),
        ),
        ModelRequest(
            parts=[ToolReturnPart(tool_name="Read", content="x", tool_call_id="c1")],
            run_id=RUN,
            timestamp=_at(2),
        ),
        # 边界时间位于第一步与第二步响应之间。
        ModelResponse(
            parts=[CompactionPart(content=summary, provider_name="function")],
            run_id=RUN,
            timestamp=_at(3),
        ),
        ModelResponse(parts=[TextPart(content="读完了")], run_id=RUN, timestamp=_at(4)),
    )

    assert [frame.frame_id for frame in live[0].steps[1].frames] == ["t1.2.compaction", "t1.2.f1"]
    assert _shape(live) == _shape(derived)


# --- 只有真实 Responses 流才有的形状 --------------------------------------------

RAW_THOUGHT = ("先想", "一", "想")


def _bailian_reasoning_stream() -> bytes:
    """百炼 Responses 流：思考只以原始思维链 reasoning_text 增量下发，没有 summary。"""

    reasoning_done = {"id": "msg_r", "type": "reasoning", "summary": []}
    message_done = {
        "id": "msg_a",
        "type": "message",
        "role": "assistant",
        "status": "completed",
        "content": [{"type": "output_text", "text": "2", "annotations": []}],
    }
    base = {
        "id": "r1",
        "object": "response",
        "created_at": 1,
        "model": "qwen3.8-flash",
        "parallel_tool_calls": False,
        "tool_choice": "auto",
        "tools": [],
    }
    reasoning_delta = {
        "type": "response.reasoning_text.delta",
        "output_index": 0,
        "item_id": "msg_r",
        "content_index": 0,
    }
    events: list[dict[str, object]] = [
        {"type": "response.created", "response": {**base, "status": "queued", "output": []}},
        {"type": "response.output_item.added", "output_index": 0, "item": reasoning_done},
        *({**reasoning_delta, "delta": chunk} for chunk in RAW_THOUGHT),
        {"type": "response.output_item.done", "output_index": 0, "item": reasoning_done},
        {
            "type": "response.output_item.added",
            "output_index": 1,
            "item": {**message_done, "content": []},
        },
        {
            "type": "response.output_text.delta",
            "output_index": 1,
            "item_id": "msg_a",
            "content_index": 0,
            "delta": "2",
        },
        {"type": "response.output_item.done", "output_index": 1, "item": message_done},
        {
            "type": "response.completed",
            "response": {
                **base,
                "status": "completed",
                "output": [reasoning_done, message_done],
                "usage": {
                    "input_tokens": 5,
                    "output_tokens": 3,
                    "total_tokens": 8,
                    "input_tokens_details": {"cached_tokens": 0},
                    "output_tokens_details": {"reasoning_tokens": 2},
                },
            },
        },
    ]
    frames = [
        f"event: {event['type']}\ndata: {json.dumps({**event, 'sequence_number': seq})}\n\n"
        for seq, event in enumerate(events)
    ]
    return "".join(frames).encode()


async def test_raw_reasoning_shows_as_thinking_on_both_paths() -> None:
    """原始思维链只在 provider_details 里，两条路都要显示出来。

    假模型的 DeltaThinkingPart 造不出 raw_content 与更新函数增量，场景测试覆盖不到；
    这里用官方 Responses 模型解析百炼形状的 SSE，pydantic-ai 改了这份约定时测试会失败。
    """

    def serve(_: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(
            200, headers={"content-type": "text/event-stream"}, content=_bailian_reasoning_stream()
        )

    client = AsyncOpenAI(
        api_key="sk-test",
        base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(serve)),
    )
    model = OpenAIResponsesModel("qwen3.8-flash", provider=AlibabaProvider(openai_client=client))
    events: list[Any] = []
    async with model.request_stream(
        [ModelRequest.user_text_prompt(PROMPT)], None, ModelRequestParameters()
    ) as stream:
        async for event in stream:
            events.append(event)
        response = stream.get()

    async def replay() -> AsyncIterator[Any]:
        for event in events:
            yield event

    thought = "".join(RAW_THOUGHT)
    thinking = response.parts[0]
    assert isinstance(thinking, ThinkingPart)
    assert thinking.content == ""
    assert thinking.provider_details == {"raw_content": [thought]}

    live = await _live(_projector(), replay())
    derived = _derived(
        ModelRequest(parts=[UserPromptPart(content=PROMPT)], run_id=RUN, timestamp=_at(0)),
        ModelResponse(parts=response.parts, run_id=RUN, timestamp=_at(1)),
    )

    shown = live[0].steps[0].frames[0]
    assert isinstance(shown, ThinkingFrame)
    assert shown.text == thought
    assert _shape(live) == _shape(derived)


# --- 子代理任务的收尾 ---------------------------------------------------------


def test_a_replayed_delegation_points_the_card_at_the_latest_child_only() -> None:
    """崩溃续跑会重放同一次 delegate；账本只记最后一个子运行，父卡也只能指向它。"""

    baseline = TranscriptTurn(
        turn_id="t1",
        ordinal=1,
        state="running",
        origin=TurnOrigin(kind="user"),
        content=CONTENT,
        steps=(
            TranscriptStep(
                step_id="t1.1",
                turn_id="t1",
                ordinal=1,
                state="interrupted",
                frames=(
                    ToolFrame(
                        frame_id="t1.1.c1",
                        tool_call_id="c1",
                        name=DELEGATE_TOOL,
                        state="running",
                        agent_refs=(AgentRef(agent_id="old-child", role="child"),),
                    ),
                ),
            ),
        ),
    )
    projector = TranscriptEventStream(
        turn_id="t1", turn_ordinal=1, resume_from=baseline, display=DISPLAYS
    )

    frame_op, _task_op = projector.note_subagent("c1", "new-child", PROFILE)

    assert isinstance(frame_op, FrameUpsertOp)
    assert frame_op.step_id == "t1.1"
    assert isinstance(frame_op.frame, ToolFrame)
    assert frame_op.frame.agent_refs == (AgentRef(agent_id="new-child", role="child"),)


async def test_the_turn_header_carries_the_prompt_that_started_it() -> None:
    """轮头两次都带触发消息的 id；耗时只在终态那次。"""

    projector = TranscriptEventStream(
        turn_id="t1", turn_ordinal=1, content=CONTENT, prompt_id="prm_1", display=DISPLAYS
    )

    async def stream() -> AsyncIterator[Any]:
        yield PartStartEvent(index=0, part=TextPart(content="好"))
        yield PartEndEvent(index=0, part=TextPart(content="好"))

    headers = [
        op.turn
        async for batch in projector.transform_stream(stream())
        for op in batch
        if isinstance(op, TurnUpsertOp)
    ]

    assert [
        (header.state, header.trigger_prompt_id, header.duration_ms is not None)
        for header in headers
    ] == [("running", "prm_1", False), ("completed", "prm_1", True)]


async def test_a_steer_before_the_first_step_keeps_its_prompt_id() -> None:
    """首步还没开就到的插话先暂存，落进首步时仍带着它来自哪条消息。"""

    projector = TranscriptEventStream(
        turn_id="t1",
        turn_ordinal=1,
        content=CONTENT,
        steered={"enq-1": "prm_s"},
        display=DISPLAYS,
    )

    async def stream() -> AsyncIterator[Any]:
        yield EnqueuedMessagesEvent(
            enqueue_id="enq-1",
            messages=(ModelRequest(parts=[UserPromptPart(content="插话")]),),
        )
        yield PartStartEvent(index=0, part=TextPart(content="好"))
        yield PartEndEvent(index=0, part=TextPart(content="好"))

    live = await _live(projector, stream())

    leading = live[0].steps[0].frames[0]
    assert (leading.frame_id, getattr(leading, "prompt_ids", None)) == ("t1.1.f1", ("prm_s",))


async def test_a_failed_turn_fails_its_running_task() -> None:
    """父运行报错时任务随轮次收尾为 failed；框架补的收尾不进历史，所以也不带它的错误文本。"""

    task = await _task_after(RuntimeError("父运行炸了"))

    assert (task.state, task.state_reason, task.error) == ("failed", None, None)


async def test_a_task_whose_call_never_came_back_is_settled_by_the_turn() -> None:
    """正常收尾但那次调用一直没结果时，任务不能停在 running。"""

    task = await _task_after(None)

    # 不带 stateReason：历史只能从子运行事件推终态，两条路要对得上。
    assert (task.state, task.state_reason) == ("failed", None)
    assert task.ended_at is not None


async def _task_after(error: BaseException | None) -> TranscriptTask:
    """派出一个子代理后按 error 结束这一轮，返回它的任务。"""

    call = ToolCallPart(
        tool_name=DELEGATE_TOOL, args={"agent_name": WRITER, "task": TASK}, tool_call_id="c1"
    )
    live = TranscriptStore()
    projector = _projector()

    async def stream() -> AsyncIterator[Any]:
        yield PartStartEvent(index=0, part=call)
        yield PartEndEvent(index=0, part=call)
        yield FunctionToolCallEvent(part=call)
        live.append(CONVERSATION, MAIN_AGENT_ID, projector.note_subagent("c1", CHILD, PROFILE))
        if error is not None:
            raise error

    async for batch in projector.transform_stream(stream()):
        live.append(CONVERSATION, MAIN_AGENT_ID, batch)
    return live.subscribe_view(CONVERSATION, MAIN_AGENT_ID).snapshot.tasks[0]
