"""transcript 场景测试：假模型跑真实运行，实时收到的页与冷启动重建的页必须一字不差。

一个场景一个用例。先比两条路（补发日志重放出来的页 vs 空实时店从持久化重建的页），
再补这个场景特有的几条事实。三个场景另存金样给前端测试消费。
"""

from __future__ import annotations

import asyncio
import difflib
import json
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from pydantic_ai import Agent, Tool
from pydantic_ai._deferred_capabilities import parse_loaded_capabilities
from pydantic_ai.exceptions import ModelRetry
from pydantic_ai.messages import (
    INTERRUPTED_TOOL_RETURN_CONTENT,
    ModelMessage,
    ModelRequest,
    ModelResponse,
    TextPart,
    ToolCallPart,
    ToolReturn,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai.models.function import (
    AgentInfo,
    DeltaThinkingCalls,
    DeltaThinkingPart,
    DeltaToolCall,
    DeltaToolCalls,
    FunctionModel,
)
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.domains.agents.public import AgentRunDeps
from iclip.domains.identity.public import Principal
from iclip.harness.agents import (
    DELEGATE_TOOL,
    AgentDefinition,
    SubAgentDefinition,
    build_agent_registry,
    delegate_display_table,
    subagent_profiles,
)
from iclip.harness.background import (
    BackgroundOutcome,
    BackgroundTools,
    is_receipt,
    parse_outcome,
)
from iclip.harness.jobs import JobQueue, JobRow
from iclip.harness.skills import build_skill_capabilities, skill_display_table
from iclip.harness.step_store_pg import PgStepStore
from iclip.harness.transcript.from_messages import ORPHAN_TOOL_ERROR
from iclip.harness.transcript.history import TranscriptHistory
from iclip.harness.transcript.runner import ConversationRunner
from iclip.harness.transcript.service import TranscriptService
from iclip.harness.transcript.store import TranscriptStore
from iclip.harness.transcript.subagents import SubAgentMirror
from iclip.platform.file_store.store import FileSpace
from iclip.platform.transcript.display import (
    FileIoDisplay,
    GenericDisplay,
    ToolDisplay,
    ToolDisplayEntry,
    ToolDisplayRegistry,
)
from iclip.platform.transcript.ops import (
    MAIN_AGENT_ID,
    TextContent,
    TextFrame,
    ToolFrame,
    TranscriptTask,
    utf16_len,
)
from iclip.platform.transcript.wire import TranscriptPage
from iclip.plugins.video_breakdown.capability import VideoBreakdown
from iclip.plugins.video_breakdown.ports import FailedBreakdown
from iclip.plugins.workspace.scope import workspace_namespace
from tests.helpers.file_store import FakeFileStore
from tests.helpers.runtime import (
    AGENT_ID,
    approval_runner,
    awaits,
    build_runner,
    calls_then_says,
    delegates,
    discarding_usage_ledger,
    drained,
    first_run_messages,
    make_runner,
    new_conversation_id,
    plant_interrupted,
    records_nothing,
    says,
    submit_text,
    texts,
    tool_cards,
    wrote,
)
from tests.helpers.transcript import (
    check_golden,
    cold_page,
    comparable,
    frames_of,
    live_page,
    normalize,
    ws_frames,
)


def _read_display(args: Any) -> ToolDisplay | None:
    path = args.get("path") if isinstance(args, dict) else None
    return FileIoDisplay(operation="read", path=path) if isinstance(path, str) and path else None


DISPLAYS = ToolDisplayRegistry.merged(
    {
        "Read": ToolDisplayEntry(draw=_read_display, view="file_content"),
        "breakdown_video": lambda _args: GenericDisplay(summary="拆解视频", detail="ref.mp4"),
    },
    delegate_display_table(),
    skill_display_table(),
)
"""非空注册表，避免两条路同时缺 display 也能相等。"""


# --- 假模型 -----------------------------------------------------------------


def thinks_then_says(thought: str, *chunks: str) -> FunctionModel:
    """一次响应：先一段思考，再按块吐正文。"""

    async def stream(
        _messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaThinkingCalls]:
        yield {0: DeltaThinkingPart(content=thought)}
        for chunk in chunks:
            yield chunk

    return FunctionModel(stream_function=stream)


def reads_then_says(path: str, reply: str) -> FunctionModel:
    """第一步读文件，第二步说一句。toolCallId 写死，金样才稳定。"""

    asked = 0

    async def stream(
        _messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        nonlocal asked
        asked += 1
        if asked == 1:
            yield {
                0: DeltaToolCall(
                    name="Read", json_args=f'{{"path": "{path}"}}', tool_call_id="call_read"
                )
            }
        else:
            yield reply

    return FunctionModel(stream_function=stream)


def read_tool() -> Tool[Any]:
    def read(path: str) -> ToolReturn:
        return ToolReturn(
            return_value="# 简报\n运动鞋，三组镜头。", metadata={"path": path, "lines": 2}
        )

    return Tool(read, name="Read")


# --- 两条路 -----------------------------------------------------------------


async def both_pages(
    store: TranscriptStore,
    step_store: PgStepStore,
    queue: JobQueue,
    runner: ConversationRunner,
    conversation_id: str,
    agent_id: str = MAIN_AGENT_ID,
) -> tuple[TranscriptPage, TranscriptPage]:
    """实时重放的页与冷启动重建的页，比对后一并返回。"""

    live = await live_page(
        store,
        conversation_id,
        agent_id,
        queue=queue,
        runner=runner,
        display=DISPLAYS,
        runtime_agent_id=AGENT_ID,
    )
    cold = await cold_page(
        step_store,
        conversation_id,
        agent_id,
        queue=queue,
        runner=runner,
        display=DISPLAYS,
        runtime_agent_id=AGENT_ID,
        delegate_tool=DELEGATE_TOOL,
    )
    assert_same_page(live, cold)
    return live, cold


def assert_same_page(live: TranscriptPage, cold: TranscriptPage) -> None:
    """两页不等时给出逐行 diff，比 pytest 对大字典的摘要好读。"""

    a = json.dumps(comparable(live), ensure_ascii=False, indent=1).splitlines()
    b = json.dumps(comparable(cold), ensure_ascii=False, indent=1).splitlines()
    if a != b:
        diff = "\n".join(difflib.unified_diff(a, b, "实时重放", "冷启动重建", lineterm="", n=2))
        raise AssertionError(f"两条路的页不一样：\n{diff}")


def _appends_to(frames: list[Any], frame_id: str) -> list[tuple[int, str]]:
    return [
        (op["offset"], op["text"])
        for frame in frames
        if frame["type"] == "transcript.ops"
        for op in frame["payload"]["ops"]
        if op["op"] == "append" and op["target"]["frameId"] == frame_id
    ]


def _args(card: ToolFrame) -> dict[str, Any]:
    """工具卡的参数：假模型给的是 JSON 字符串，真厂商多是对象，两种都认。"""

    return json.loads(card.input) if isinstance(card.input, str) else dict(card.input or {})


# --- 场景 -------------------------------------------------------------------


async def test_thinking_then_text_with_emoji(engine: AsyncEngine) -> None:
    store = TranscriptStore()
    runner, step_store, queue = build_runner(
        engine,
        thinks_then_says("先想想怎么拆", "好👌，", "分三组🎬拍。"),
        store=store,
        display=DISPLAYS,
        context_limits={},
    )
    conversation_id = new_conversation_id()

    await submit_text(runner, queue, conversation_id, "给这条视频做分镜")
    await drained(queue, conversation_id)
    await runner.shutdown()
    live, _cold = await both_pages(store, step_store, queue, runner, conversation_id)

    frames = frames_of(live, "t1", "t1.1")
    assert [(frame.frame_id, frame.kind) for frame in frames] == [
        ("t1.1.f1", "thinking"),
        ("t1.1.f2", "text"),
    ]
    assert frames[1].text == "好👌，分三组🎬拍。"
    # 逐字追加的 offset 按 UTF-16 累加，emoji 占两个单位。
    assert _appends_to(ws_frames(store, conversation_id), "t1.1.f2") == [
        (0, "好👌，"),
        (utf16_len("好👌，"), "分三组🎬拍。"),
    ]


async def test_a_tool_call_then_a_reply_make_two_steps(engine: AsyncEngine) -> None:
    store = TranscriptStore()
    runner, step_store, queue = build_runner(
        engine,
        reads_then_says("brief.md", "读完了，开拆。"),
        store=store,
        tools=[read_tool()],
        display=DISPLAYS,
        context_limits={},
    )
    conversation_id = new_conversation_id()

    await submit_text(runner, queue, conversation_id, "先看简报再拆")
    await drained(queue, conversation_id)
    await runner.shutdown()
    live, cold = await both_pages(store, step_store, queue, runner, conversation_id)

    assert [step.step_id for step in live.items[0].steps] == ["t1.1", "t1.2"]
    card = frames_of(live, "t1", "t1.1")[0]
    assert isinstance(card, ToolFrame)
    assert (card.state, card.view, card.display) == (
        "done",
        "file_content",
        FileIoDisplay(operation="read", path="brief.md"),
    )
    assert card.metadata == {"path": "brief.md", "lines": 2}
    check_golden(
        "tool-turn", {"ws": normalize(ws_frames(store, conversation_id)), "rest": comparable(cold)}
    )


async def test_a_tool_that_rejects_its_input_settles_the_card_as_an_error(
    engine: AsyncEngine,
) -> None:
    def boom() -> str:
        raise ModelRetry("简报读不到，换个路径")

    store = TranscriptStore()
    runner, step_store, queue = build_runner(
        engine,
        calls_then_says("Boom", "那我先不读了"),
        store=store,
        tools=[Tool(boom, name="Boom")],
        display=DISPLAYS,
        context_limits={},
    )
    conversation_id = new_conversation_id()

    await submit_text(runner, queue, conversation_id, "读一下简报")
    await drained(queue, conversation_id)
    await runner.shutdown()
    live, _cold = await both_pages(store, step_store, queue, runner, conversation_id)

    card = frames_of(live, "t1", "t1.1")[0]
    assert isinstance(card, ToolFrame)
    assert card.state == "error"
    assert card.error is not None and "简报读不到" in card.error
    assert live.items[0].state == "completed"


async def test_a_steer_lands_on_the_step_that_was_running(engine: AsyncEngine) -> None:
    entered, gate = asyncio.Event(), asyncio.Event()
    store = TranscriptStore()
    runner, step_store, queue = build_runner(
        engine,
        waits_then_says(entered, gate, "第一句", "补充收到了"),
        store=store,
        display=DISPLAYS,
        context_limits={},
    )
    conversation_id = new_conversation_id()

    await submit_text(runner, queue, conversation_id, "先做这个")
    second = await submit_text(runner, queue, conversation_id, "临时插一句")
    await entered.wait()
    await runner.steer(conversation_id, (second,))
    gate.set()
    await drained(queue, conversation_id)
    await runner.shutdown()
    live, _cold = await both_pages(store, step_store, queue, runner, conversation_id)

    # 插话挂在当时正在跑的那一步末尾，与正文共用块序号；模型的回应开新的一步。
    assert [
        (frame.frame_id, getattr(frame, "role", None), getattr(frame, "prompt_ids", None))
        for frame in frames_of(live, "t1", "t1.1")
    ] == [
        ("t1.1.f1", "assistant", None),
        ("t1.1.f2", "user", (second,)),
    ]
    assert [step.step_id for step in live.items[0].steps] == ["t1.1", "t1.2"]


async def test_stopping_the_run_ends_the_turn_as_cancelled(engine: AsyncEngine) -> None:
    """第二步说到一半被停。官方只在节点边界存快照，第一步就停的轮历史里没有，那是持久化的边界。"""

    entered = asyncio.Event()
    store = TranscriptStore()
    runner, step_store, queue = build_runner(
        engine,
        reads_then_hangs(entered),
        store=store,
        tools=[read_tool()],
        display=DISPLAYS,
        context_limits={},
    )
    conversation_id = new_conversation_id()

    prompt_id = await submit_text(runner, queue, conversation_id, "看完简报慢慢想")
    await entered.wait()
    await runner.abort(conversation_id, prompt_id)
    await drained(queue, conversation_id)
    await runner.shutdown()
    live, _cold = await both_pages(store, step_store, queue, runner, conversation_id)

    assert [turn.state for turn in live.items] == ["cancelled"]
    assert [step.step_id for step in live.items[0].steps] == ["t1.1", "t1.2"]
    assert frames_of(live, "t1", "t1.2")[0].text == "想到一半"
    assert live.meta.activity == "idle"


async def test_a_model_failure_ends_the_turn_as_failed(engine: AsyncEngine) -> None:
    """第二步说到一半上游炸了；第一步就炸的轮同上，历史里没有。"""

    store = TranscriptStore()
    runner, step_store, queue = build_runner(
        engine,
        reads_then_explodes("上游炸了"),
        store=store,
        tools=[read_tool()],
        display=DISPLAYS,
        context_limits={},
        max_attempts=1,
    )
    conversation_id = new_conversation_id()

    await submit_text(runner, queue, conversation_id, "看完简报来一段")
    await drained(queue, conversation_id)
    await runner.shutdown()
    live, _cold = await both_pages(store, step_store, queue, runner, conversation_id)

    turn = live.items[0]
    assert turn.state == "failed"
    assert turn.error is not None and "上游炸了" in turn.error
    assert [step.step_id for step in turn.steps] == ["t1.1", "t1.2"]
    assert frames_of(live, "t1", "t1.2")[0].text == "刚开口"


async def test_an_approved_tool_resumes_the_same_turn(engine: AsyncEngine) -> None:
    store = TranscriptStore()
    runner, step_store, queue = approval_runner(engine, store)
    conversation_id = new_conversation_id()

    prompt_id = await submit_text(runner, queue, conversation_id, "把这个文件改掉")
    await awaits(queue, prompt_id)
    await runner.approve(conversation_id, "apr_call_1", approved=True)
    await drained(queue, conversation_id)
    await runner.shutdown()
    live, _cold = await both_pages(store, step_store, queue, runner, conversation_id)

    # 审批前后是两个 run，合成一轮、步号连续；交互是不分页的全局实体。
    assert [step.step_id for step in live.items[0].steps] == ["t1.1", "t1.2"]
    card = frames_of(live, "t1", "t1.1")[0]
    assert isinstance(card, ToolFrame)
    assert (card.state, card.approval_id) == ("done", "apr_call_1")
    assert [(item.interaction_id, item.state) for item in live.interactions] == [
        ("apr_call_1", "approved")
    ]
    assert live.pending_interactions == ()


async def test_a_rejected_tool_settles_as_an_error_and_the_model_moves_on(
    engine: AsyncEngine,
) -> None:
    store = TranscriptStore()
    runner, step_store, queue = approval_runner(engine, store, reply="那我不动它")
    conversation_id = new_conversation_id()

    prompt_id = await submit_text(runner, queue, conversation_id, "把这个文件改掉")
    await awaits(queue, prompt_id)
    await runner.approve(conversation_id, "apr_call_1", approved=False)
    await drained(queue, conversation_id)
    await runner.shutdown()
    live, _cold = await both_pages(store, step_store, queue, runner, conversation_id)

    card = frames_of(live, "t1", "t1.1")[0]
    assert isinstance(card, ToolFrame)
    assert card.state == "error"
    assert [item.state for item in live.interactions] == ["rejected"]
    assert frames_of(live, "t1", "t1.2")[0].text == "那我不动它"


async def test_a_crashed_run_resumes_into_the_same_turn(engine: AsyncEngine) -> None:
    store = TranscriptStore()
    runner, step_store, queue = build_runner(
        engine, says("接着写完了"), store=store, display=DISPLAYS, context_limits={}
    )
    conversation_id = new_conversation_id()
    dead_run = f"{AGENT_ID}-dead"
    await plant_interrupted(
        engine,
        step_store,
        queue,
        conversation_id,
        run_id=dead_run,
        messages=first_run_messages(dead_run),
    )

    await runner.sweep_once()
    await drained(queue, conversation_id)
    await runner.shutdown()
    live, _cold = await both_pages(store, step_store, queue, runner, conversation_id)

    # 续跑是新 run，但落回原轮：旧步标中断、新步接着编号，用户消息不重复。
    assert [(turn.turn_id, turn.state) for turn in live.items] == [("t1", "completed")]
    assert [step.state for step in live.items[0].steps] == ["interrupted", "completed"]
    assert [frame.frame_id for frame in frames_of(live, "t1", "t1.1")] == ["t1.1.call_1"]
    assert frames_of(live, "t1", "t1.2")[0].text == "接着写完了"


async def test_regenerating_the_last_turn_replaces_it(engine: AsyncEngine) -> None:
    store = TranscriptStore()
    runner, step_store, queue = build_runner(
        engine, says("第一次", "第二次"), store=store, display=DISPLAYS, context_limits={}
    )
    conversation_id = new_conversation_id()
    service = TranscriptService(
        store=store,
        history=TranscriptHistory(step_store, queue, DISPLAYS, DELEGATE_TOOL),
        queue=queue,
        runner=runner,
        context_limits={},
        record_materials=records_nothing,
    )

    first = await submit_text(runner, queue, conversation_id, "写一句")
    await drained(queue, conversation_id)
    again = await service.regenerate(conversation_id=conversation_id, turn_id="t1")
    await drained(queue, conversation_id)
    await runner.shutdown()
    live, _cold = await both_pages(store, step_store, queue, runner, conversation_id)

    # 重跑前先删旧轮，新的一轮沿用 t1，但认领的是新那条消息。
    removals = [
        op
        for frame in ws_frames(store, conversation_id)
        if frame["type"] == "transcript.ops"
        for op in frame["payload"]["ops"]
        if op["op"] == "items.remove"
    ]
    assert [list(op["ids"]) for op in removals] == [["t1"]]
    assert [(turn.turn_id, turn.trigger_prompt_id) for turn in live.items] == [
        ("t1", again.prompt_id)
    ]
    assert again.prompt_id != first
    assert frames_of(live, "t1", "t1.1")[0].text == "第二次"


# --- 压缩 -----------------------------------------------------------------------

SKILL = "storyboard"
SKILL_BODY = "分镜按三组写，每组三个镜头。"
LOAD_CALL = "call_load"


def loads_skill_then_says(delivered: list[bool]) -> FunctionModel:
    """首轮先加载技能再答，之后每次直接答；每次对话请求记下技能正文是否送达。摘要请求回一段摘要。"""

    def summarize(_messages: list[ModelMessage], _info: AgentInfo) -> ModelResponse:
        return ModelResponse(parts=[TextPart(content="## Intent\n给视频做分镜")])

    async def stream(
        messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        delivered.append(
            any(
                isinstance(part, UserPromptPart)
                and f'context id="capability:{SKILL}"' in str(part.content)
                and SKILL_BODY in str(part.content)
                for message in messages
                for part in message.parts
            )
        )
        if len(delivered) == 1:
            yield {
                0: DeltaToolCall(
                    name="load_capability", json_args=f'{{"id": "{SKILL}"}}', tool_call_id=LOAD_CALL
                )
            }
        else:
            yield "好的。"

    return FunctionModel(summarize, stream_function=stream)


async def test_a_skill_loaded_before_compaction_stays_loaded_and_shows_its_recorded_load(
    engine: AsyncEngine, tmp_path: Path
) -> None:
    """窗口小到每次请求都压：压掉的技能加载补记一次，刷新前后同一步各显示一张加载卡。"""

    (tmp_path / SKILL).mkdir()
    (tmp_path / SKILL / "SKILL.md").write_text(
        f"---\nname: {SKILL}\ndescription: 写分镜\n---\n\n{SKILL_BODY}\n", encoding="utf-8"
    )
    delivered: list[bool] = []
    store = TranscriptStore()
    runner, step_store, queue = build_runner(
        engine,
        loads_skill_then_says(delivered),
        store=store,
        display=DISPLAYS,
        capabilities=build_skill_capabilities(tmp_path, (SKILL,)),
        context_limits={AGENT_ID: 1},
        compaction_keep_messages=2,
    )
    conversation_id = new_conversation_id()

    for prompt in ("加载技能写分镜", "改第二组", "再改第三组"):
        await submit_text(runner, queue, conversation_id, prompt)
        await drained(queue, conversation_id)
    await runner.shutdown()
    live, _cold = await both_pages(store, step_store, queue, runner, conversation_id)

    # 加载之后每次请求都带着技能正文，两次压掉加载也一样。
    assert delivered == [False, True, True, True]
    assert [[step.step_id for step in turn.steps] for turn in live.items] == [
        ["t1.1", "t1.2"],
        ["t2.1"],
        ["t3.1"],
    ]
    # 第一轮压缩时加载还在保留的尾部里，不补记；后两轮压掉了加载，各补记一次，卡挂在压缩提示后面。
    steps = {step.step_id: step for turn in live.items for step in turn.steps}
    assert [
        step_id
        for step_id, step in steps.items()
        if any(frame.kind == "notice" for frame in step.frames)
    ] == ["t1.2", "t2.1", "t3.1"]
    assert [frame.kind for frame in steps["t2.1"].frames] == ["notice", "tool", "text"]
    assert [frame.kind for frame in steps["t3.1"].frames] == ["notice", "tool", "text"]
    cards = [
        (step_id, frame)
        for step_id, step in steps.items()
        for frame in step.frames
        if isinstance(frame, ToolFrame) and frame.name == "load_capability"
    ]
    assert [step_id for step_id, _ in cards] == ["t1.1", "t2.1", "t3.1"]
    assert cards[0][1].tool_call_id == LOAD_CALL
    assert len({card.tool_call_id for _, card in cards}) == 3
    assert {(card.state, card.display) for _, card in cards} == {
        ("done", GenericDisplay(summary="加载技能", detail=SKILL))
    }


async def test_regenerating_a_compacting_turn_keeps_the_skill_loaded(
    engine: AsyncEngine, tmp_path: Path
) -> None:
    (tmp_path / SKILL).mkdir()
    (tmp_path / SKILL / "SKILL.md").write_text(
        f"---\nname: {SKILL}\ndescription: 写分镜\n---\n\n{SKILL_BODY}\n", encoding="utf-8"
    )
    delivered: list[bool] = []
    store = TranscriptStore()
    runner, step_store, queue = build_runner(
        engine,
        loads_skill_then_says(delivered),
        store=store,
        display=DISPLAYS,
        capabilities=build_skill_capabilities(tmp_path, (SKILL,)),
        context_limits={AGENT_ID: 1},
        compaction_keep_messages=3,
    )
    service = TranscriptService(
        store=store,
        history=TranscriptHistory(step_store, queue, DISPLAYS, DELEGATE_TOOL),
        queue=queue,
        runner=runner,
        context_limits={AGENT_ID: 1},
        record_materials=records_nothing,
    )
    conversation_id = new_conversation_id()

    for prompt in ("加载技能写分镜", "改第二组", "再改第三组"):
        await submit_text(runner, queue, conversation_id, prompt)
        await drained(queue, conversation_id)
    await service.regenerate(conversation_id=conversation_id, turn_id="t3")
    await drained(queue, conversation_id)
    await submit_text(runner, queue, conversation_id, "再改第四组")
    await drained(queue, conversation_id)
    await runner.shutdown()
    live, _cold = await both_pages(store, step_store, queue, runner, conversation_id)

    snapshot = await step_store.latest_conversation_snapshot(
        conversation_id=conversation_id, include_interrupted=True
    )
    assert snapshot is not None
    assert SKILL in parse_loaded_capabilities(snapshot.messages)
    assert delivered[0] is False
    assert all(delivered[1:])
    cards = [
        frame
        for turn in live.items
        for step in turn.steps
        for frame in step.frames
        if isinstance(frame, ToolFrame) and frame.name == "load_capability"
    ]
    assert cards
    assert {card.state for card in cards} == {"done"}


# --- 后台工具 -------------------------------------------------------------------

BREAKDOWN_CALL = "call_bd"
BREAKDOWN_DONE = "视频拆解完毕，文档在 references/ref.md。"
BREAKDOWN_ARGS = '{"video_url": "https://cdn.test/ref.mp4"}'


def slow_breakdown(release: asyncio.Event) -> Tool[Any]:
    """后台跑的拆解：等测试放行才返回。"""

    async def breakdown_video(video_url: str) -> str:
        await release.wait()
        return BREAKDOWN_DONE

    return Tool(breakdown_video, name="breakdown_video", metadata={"background": True})


def sequential_write() -> Tool[Any]:
    """与工作区写文件工具一样依次执行。"""

    def write_file(path: str) -> str:
        return f"{path} 写好了"

    return Tool(write_file, name="write_file", sequential=True)


def _outcomes(messages: list[ModelMessage]) -> list[BackgroundOutcome]:
    return [
        outcome
        for message in messages
        if isinstance(message, ModelRequest)
        for part in message.parts
        if isinstance(part, UserPromptPart)
        if (outcome := parse_outcome(part)) is not None
    ]


def _breakdown_call(tool_call_id: str = BREAKDOWN_CALL) -> DeltaToolCall:
    return DeltaToolCall(
        name="breakdown_video", json_args=BREAKDOWN_ARGS, tool_call_id=tool_call_id
    )


def waits_for_breakdown(
    ended: asyncio.Event, *, write: bool = False, seen: list[list[ModelMessage]] | None = None
) -> FunctionModel:
    """首个请求调拆解（write 时同一响应里再写一份简报）；拆解没回来就说一句、结束这次响应，回来了
    再答一句。用户另起一条「继续」时直接答。seen 记下每次请求模型收到的消息。"""

    async def stream(
        messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        if seen is not None:
            seen.append(list(messages))
        last = messages[-1]
        if len(messages) == 1:
            calls = {0: _breakdown_call()}
            if write:
                calls[1] = DeltaToolCall(
                    name="write_file", json_args='{"path": "brief.md"}', tool_call_id="call_write"
                )
            yield calls
        elif isinstance(last, ModelRequest) and texts([last]) == ["继续"]:
            yield "好，接着来。"
        elif _outcomes(messages):
            yield "拆解好了，接着写分镜。"
        else:
            yield "简报写好了，等拆解。"
            ended.set()

    return FunctionModel(stream_function=stream)


async def _history(step_store: PgStepStore, conversation_id: str) -> list[ModelMessage]:
    snapshot = await step_store.latest_conversation_snapshot(
        conversation_id=conversation_id, include_interrupted=True
    )
    assert snapshot is not None
    return list(snapshot.messages)


def _user_frames(page: TranscriptPage) -> list[TextFrame]:
    return [
        frame
        for turn in page.items
        for step in turn.steps
        for frame in step.frames
        if isinstance(frame, TextFrame) and frame.role == "user"
    ]


def _breakdown_card(page: TranscriptPage, tool_call_id: str = BREAKDOWN_CALL) -> ToolFrame:
    (card,) = [card for card in tool_cards(page.items) if card.tool_call_id == tool_call_id]
    return card


BREAKDOWN_TITLE = "拆解视频 ref.mp4"
"""DISPLAYS 给拆解卡的标题，任务描述与完成通知都用它。"""


def _breakdown_task(page: TranscriptPage, tool_call_id: str = BREAKDOWN_CALL) -> TranscriptTask:
    """这次后台调用的任务；描述是卡标题，id 是调用 id。"""

    (task,) = [task for task in page.tasks if task.task_id == tool_call_id]
    assert (task.kind, task.detached, task.description) == ("tool", True, BREAKDOWN_TITLE)
    assert task.started_at is not None
    return task


def _receipt(messages: list[ModelMessage], tool_call_id: str = BREAKDOWN_CALL) -> ToolReturnPart:
    (receipt,) = [
        part
        for message in messages
        for part in message.parts
        if isinstance(part, ToolReturnPart) and part.tool_call_id == tool_call_id
    ]
    assert is_receipt(receipt)
    return receipt


def _assert_settled_by_receipt(card: ToolFrame, receipt: ToolReturnPart) -> None:
    """原卡只记启动：回执到达即正常结卡，output 是回执原文。"""

    assert (card.state, card.output, card.error) == ("done", receipt.content, None)


def _assert_interrupted(card: ToolFrame, task: TranscriptTask, state: str) -> None:
    """回执之后没等到结果、运行已不在：卡收成中断，任务进入终态，不带结果与错误。"""

    assert (card.state, card.output, card.metadata, card.error) == (
        "error",
        None,
        None,
        ORPHAN_TOOL_ERROR,
    )
    assert (task.state, task.result_summary, task.error) == (state, None, None)
    assert task.ended_at is not None


async def test_a_background_breakdown_lets_the_model_write_first_and_settles_later(
    engine: AsyncEngine,
) -> None:
    ended, release = asyncio.Event(), asyncio.Event()
    store = TranscriptStore()
    runner, step_store, queue = build_runner(
        engine,
        waits_for_breakdown(ended, write=True),
        store=store,
        tools=[slow_breakdown(release), sequential_write()],
        capabilities=[BackgroundTools()],
        display=DISPLAYS,
        context_limits={},
    )
    conversation_id = new_conversation_id()

    await submit_text(runner, queue, conversation_id, "拆一下这条视频")
    await ended.wait()
    release.set()
    await drained(queue, conversation_id)
    await runner.shutdown()
    live, cold = await both_pages(store, step_store, queue, runner, conversation_id)

    # 模型在拆解跑着时结束了响应，结果到了被拉回来再答一次：中间没有工具调用，也开新的一步。
    assert [step.step_id for step in live.items[0].steps] == ["t1.1", "t1.2", "t1.3"]
    messages = await _history(step_store, conversation_id)
    card = _breakdown_card(live)
    _assert_settled_by_receipt(card, _receipt(messages))
    assert card.frame_id == f"t1.1.{BREAKDOWN_CALL}"
    # 结果到达处（当时的末步）插一条完成通知，原卡不动。
    notice = TextFrame(
        frame_id="t1.2.f2",
        role="user",
        text=f"已{BREAKDOWN_TITLE}",
        content=(TextContent(text=f"已{BREAKDOWN_TITLE}"),),
        task_id=BREAKDOWN_CALL,
    )
    assert frames_of(live, "t1", "t1.2")[-1] == notice
    assert _user_frames(live) == [notice]
    task = _breakdown_task(live)
    assert (task.state, task.result_summary, task.error) == ("completed", BREAKDOWN_DONE, None)
    assert task.ended_at is not None
    assert live.items[0].content == (TextContent(text="拆一下这条视频"),)
    written = next(
        index
        for index, message in enumerate(messages)
        if any(
            isinstance(part, ToolReturnPart) and part.tool_name == "write_file"
            for part in message.parts
        )
    )
    delivered = next(index for index, message in enumerate(messages) if _outcomes([message]))
    assert written < delivered

    sample = {"ws": normalize(ws_frames(store, conversation_id)), "rest": comparable(cold)}
    # 前端 schema 会剥掉未声明的字段：金样里要真有完成通知的 taskId 与 tool 任务，前端才测得出漏声明。
    rest = sample["rest"]
    frames = [frame for turn in rest["items"] for step in turn["steps"] for frame in step["frames"]]
    assert [frame["taskId"] for frame in frames if "taskId" in frame] == [BREAKDOWN_CALL]
    assert [(item["kind"], item["detached"]) for item in rest["tasks"]] == [("tool", True)]
    check_golden("background-turn", sample)


async def test_a_steer_during_a_background_wait_still_shows_and_the_outcome_settles(
    engine: AsyncEngine,
) -> None:
    ended, release = asyncio.Event(), asyncio.Event()
    store = TranscriptStore()
    runner, step_store, queue = build_runner(
        engine,
        waits_for_breakdown(ended),
        store=store,
        tools=[slow_breakdown(release)],
        capabilities=[BackgroundTools()],
        display=DISPLAYS,
        context_limits={},
    )
    conversation_id = new_conversation_id()

    await submit_text(runner, queue, conversation_id, "拆一下这条视频")
    second = await submit_text(runner, queue, conversation_id, "临时插一句")
    await ended.wait()
    await runner.steer(conversation_id, (second,))
    release.set()
    await drained(queue, conversation_id)
    await runner.shutdown()
    live, _cold = await both_pages(store, step_store, queue, runner, conversation_id)

    # 插话与完成通知各是一块，按递入先后挂在当时的末步：插话让模型先答一次，结果到时末步已是下一步。
    # 插话带消息 id，通知带任务 id。
    assert [
        (frame.frame_id, frame.text, frame.prompt_ids, frame.task_id)
        for frame in _user_frames(live)
    ] == [
        ("t1.2.f2", "临时插一句", (second,), None),
        ("t1.3.f2", f"已{BREAKDOWN_TITLE}", None, BREAKDOWN_CALL),
    ]
    _assert_settled_by_receipt(
        _breakdown_card(live), _receipt(await _history(step_store, conversation_id))
    )
    assert _breakdown_task(live).state == "completed"


async def test_stopping_during_a_background_breakdown_interrupts_the_call(
    engine: AsyncEngine,
) -> None:
    ended, never = asyncio.Event(), asyncio.Event()
    seen: list[list[ModelMessage]] = []
    store = TranscriptStore()
    runner, step_store, queue = build_runner(
        engine,
        waits_for_breakdown(ended, seen=seen),
        store=store,
        tools=[slow_breakdown(never)],
        capabilities=[BackgroundTools()],
        display=DISPLAYS,
        context_limits={},
    )
    conversation_id = new_conversation_id()

    prompt_id = await submit_text(runner, queue, conversation_id, "拆一下这条视频")
    await ended.wait()
    await runner.abort(conversation_id, prompt_id)
    await drained(queue, conversation_id)
    live, _cold = await both_pages(store, step_store, queue, runner, conversation_id)

    assert [turn.state for turn in live.items] == ["cancelled"]
    _assert_interrupted(_breakdown_card(live), _breakdown_task(live), "killed")
    assert _user_frames(live) == []

    await submit_text(runner, queue, conversation_id, "继续")
    await drained(queue, conversation_id)
    await runner.shutdown()
    live, _cold = await both_pages(store, step_store, queue, runner, conversation_id)

    # 下一轮交给模型的历史里，回执换成了 interrupted 返回，模型不会再等一个不会来的结果。
    returns = [
        part
        for message in seen[-1]
        for part in message.parts
        if isinstance(part, ToolReturnPart) and part.tool_call_id == BREAKDOWN_CALL
    ]
    assert [(part.outcome, part.content) for part in returns] == [
        ("interrupted", INTERRUPTED_TOOL_RETURN_CONTENT)
    ]
    assert [turn.state for turn in live.items] == ["cancelled", "completed"]
    _assert_interrupted(_breakdown_card(live), _breakdown_task(live), "killed")


def breaks_down_and_writes(reply: str) -> FunctionModel:
    """首个请求在同一响应里调后台拆解和一件要审批的写文件，之后的请求直接答。"""

    asked = 0

    async def stream(
        _messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        nonlocal asked
        asked += 1
        if asked == 1:
            yield {
                0: _breakdown_call(),
                1: DeltaToolCall(name="write_file", json_args="{}", tool_call_id="call_1"),
            }
        else:
            yield reply

    return FunctionModel(stream_function=stream)


async def test_an_approval_pause_closes_the_background_card_and_keeps_the_approval_open(
    engine: AsyncEngine,
) -> None:
    never = asyncio.Event()
    store = TranscriptStore()
    runner, step_store, queue = build_runner(
        engine,
        breaks_down_and_writes("改完了"),
        store=store,
        tools=[slow_breakdown(never), Tool(wrote, name="write_file", requires_approval=True)],
        capabilities=[BackgroundTools()],
        display=DISPLAYS,
        context_limits={},
    )
    conversation_id = new_conversation_id()

    prompt_id = await submit_text(runner, queue, conversation_id, "拆一下视频，再改文件")
    await awaits(queue, prompt_id)
    live, _cold = await both_pages(store, step_store, queue, runner, conversation_id)

    # 暂停时没跑完的后台调用被丢掉，卡收成中断、任务 killed；等审批的卡带着审批 id 保持开放。
    assert live.items[0].state == "running"
    _assert_interrupted(_breakdown_card(live), _breakdown_task(live), "killed")
    approval = _breakdown_card(live, "call_1")
    assert (approval.state, approval.approval_id) == ("running", "apr_call_1")

    await runner.approve(conversation_id, "apr_call_1", approved=True)
    await drained(queue, conversation_id)
    await runner.shutdown()
    live, _cold = await both_pages(store, step_store, queue, runner, conversation_id)

    assert live.items[0].state == "completed"
    assert [step.step_id for step in live.items[0].steps] == ["t1.1", "t1.2"]
    _assert_interrupted(_breakdown_card(live), _breakdown_task(live), "killed")
    approval = _breakdown_card(live, "call_1")
    assert (approval.state, approval.approval_id) == ("done", "apr_call_1")
    assert frames_of(live, "t1", "t1.2")[0].text == "改完了"


async def _receipt_without_outcome(run_id: str) -> list[ModelMessage]:
    """真跑一次后台拆解，截到回执那条请求：等同于在模型下一次作答时崩了留下的快照。"""

    async def breakdown_video(video_url: str) -> str:
        await asyncio.sleep(0.2)
        return BREAKDOWN_DONE

    def script(messages: list[ModelMessage], _info: AgentInfo) -> ModelResponse:
        if len(messages) == 1:
            return ModelResponse(
                parts=[ToolCallPart("breakdown_video", BREAKDOWN_ARGS, tool_call_id=BREAKDOWN_CALL)]
            )
        return ModelResponse(parts=[TextPart("等拆解。")])

    agent = Agent(
        FunctionModel(script),
        tools=[Tool(breakdown_video, name="breakdown_video", metadata={"background": True})],
        capabilities=[BackgroundTools()],
    )
    messages = (await agent.run("把这三个镜头出图", run_id=run_id)).all_messages()[:3]
    assert not _outcomes(messages), "截下来的快照里不该已经有结果"
    return messages


async def test_a_crash_during_a_background_breakdown_resumes_with_the_call_interrupted(
    engine: AsyncEngine,
) -> None:
    seen: list[list[ModelMessage]] = []

    async def stream(
        messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        seen.append(list(messages))
        yield "拆解没有结果，换个办法。"

    store = TranscriptStore()
    runner, step_store, queue = build_runner(
        engine,
        FunctionModel(stream_function=stream),
        store=store,
        capabilities=[BackgroundTools()],
        display=DISPLAYS,
        context_limits={},
    )
    conversation_id = new_conversation_id()
    dead_run = f"{AGENT_ID}-dead"
    await plant_interrupted(
        engine,
        step_store,
        queue,
        conversation_id,
        run_id=dead_run,
        messages=await _receipt_without_outcome(dead_run),
    )
    # 续跑前刷新：死掉的运行留下回执却没有结果，卡收成中断、任务 failed。
    before = await cold_page(
        step_store,
        conversation_id,
        MAIN_AGENT_ID,
        queue=queue,
        runner=runner,
        display=DISPLAYS,
        runtime_agent_id=AGENT_ID,
        delegate_tool=DELEGATE_TOOL,
    )
    _assert_interrupted(_breakdown_card(before), _breakdown_task(before), "failed")

    await runner.sweep_once()
    await drained(queue, conversation_id)
    await runner.shutdown()
    live, cold = await both_pages(store, step_store, queue, runner, conversation_id)

    (received,) = seen
    returns = [
        part
        for message in received
        for part in message.parts
        if isinstance(part, ToolReturnPart) and part.tool_call_id == BREAKDOWN_CALL
    ]
    assert [(part.outcome, part.content) for part in returns] == [
        ("interrupted", INTERRUPTED_TOOL_RETURN_CONTENT)
    ]
    assert [step.state for step in live.items[0].steps] == ["interrupted", "completed"]
    # 续跑后回执已换成带标记的 interrupted 返回：历史仍认得出这次后台调用，续跑基线也带上了任务。
    _assert_interrupted(_breakdown_card(live), _breakdown_task(live), "failed")
    assert _breakdown_task(cold).started_at == _breakdown_task(before).started_at, (
        "换下的返回保留回执的时间戳"
    )


class FailingBreakdowns:
    """参考视频拆解的替身：每次都是模型调用失败；记下被要了几次。"""

    def __init__(self) -> None:
        self.calls = 0

    async def ensure(self, principal: Principal, video_url: str) -> str | FailedBreakdown:
        self.calls += 1
        return FailedBreakdown(reason="model_call_failed")


CALL_AGAIN = "拆解失败，再调用一次。"


async def test_a_retryable_breakdown_failure_reaches_the_model_and_errors_the_card(
    engine: AsyncEngine,
) -> None:
    """真 VideoBreakdown 挂 BackgroundTools：可重试的失败作为后台结果送到模型，卡片记错误；模型照
    提示再调一次，就再排一次拆解。"""

    seen: list[list[ModelMessage]] = []

    async def stream(
        messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        seen.append(list(messages))
        failed = [item for item in _outcomes(messages) if item.state == "error"]
        last_is_outcome = isinstance(messages[-1], ModelRequest) and _outcomes([messages[-1]])
        if len(messages) == 1:
            yield {0: _breakdown_call("call_bd1")}
        elif last_is_outcome and len(failed) == 1:
            yield {0: _breakdown_call("call_bd2")}
        elif last_is_outcome:
            yield "拆解没成，请稍后再试。"
        else:
            yield "等拆解。"

    breakdowns = FailingBreakdowns()
    capability = VideoBreakdown[Any](
        space=FileSpace(store=FakeFileStore(), namespace=workspace_namespace),
        breakdowns=breakdowns,
    )

    async def deps_for(row: JobRow) -> AgentRunDeps:
        return AgentRunDeps(
            principal=Principal(
                kind="user",
                user_id=row.owner_user_id,
                permissions=frozenset({"agent:run"}),
                audit_label="logan",
                api_key_id=None,
            ),
            conversation_id=row.conversation_id,
            user_name="logan",
        )

    store = TranscriptStore()
    runner, step_store, queue = build_runner(
        engine,
        FunctionModel(stream_function=stream),
        store=store,
        capabilities=[capability, BackgroundTools()],
        deps_for=deps_for,
        display=DISPLAYS,
        context_limits={},
    )
    conversation_id = new_conversation_id()

    await submit_text(runner, queue, conversation_id, "拆一下这条视频")
    await drained(queue, conversation_id)
    await runner.shutdown()
    live, _cold = await both_pages(store, step_store, queue, runner, conversation_id)

    assert [(item.tool_call_id, item.state, item.text) for item in _outcomes(seen[-1])] == [
        ("call_bd1", "error", CALL_AGAIN),
        ("call_bd2", "error", CALL_AGAIN),
    ]
    assert breakdowns.calls == 2, "每次再调都重新排一次拆解"
    # 失败的结果不改原卡；到达处插「… 失败」的通知，任务 failed 并带错误原文。
    messages = await _history(step_store, conversation_id)
    for tool_call_id in ("call_bd1", "call_bd2"):
        _assert_settled_by_receipt(
            _breakdown_card(live, tool_call_id), _receipt(messages, tool_call_id)
        )
        task = _breakdown_task(live, tool_call_id)
        assert (task.state, task.result_summary, task.error) == ("failed", None, CALL_AGAIN)
    assert [(frame.text, frame.task_id) for frame in _user_frames(live)] == [
        (f"{BREAKDOWN_TITLE} 失败", "call_bd1"),
        (f"{BREAKDOWN_TITLE} 失败", "call_bd2"),
    ]


# --- 子代理 -------------------------------------------------------------------

WRITER = "shot-writer"
COPY = "copy-writer"
TASK = "写第 3 组的三个镜头"


async def test_a_delegation_becomes_its_own_stream(engine: AsyncEngine, tmp_path: Path) -> None:
    store = TranscriptStore()
    writer = says("S3-1 特写；S3-2 中景；S3-3 全景")
    runner, step_store, queue = subagent_runner(
        engine, tmp_path, store=store, parent=delegates((WRITER, TASK)), children={WRITER: writer}
    )
    conversation_id = new_conversation_id()

    prompt_id = await submit_text(runner, queue, conversation_id, "给这条视频做分镜")
    await drained(queue, conversation_id)
    await runner.shutdown()
    live, cold = await both_pages(store, step_store, queue, runner, conversation_id)

    card = frames_of(live, "t1", "t1.1")[0]
    assert isinstance(card, ToolFrame)
    assert card.agent_refs is not None and len(card.agent_refs) == 1
    child_id = card.agent_refs[0].agent_id
    assert [
        (task.task_id, task.state, task.description, task.result_summary, task.model)
        for task in live.tasks
    ] == [(child_id, "completed", WRITER, "S3-1 特写；S3-2 中景；S3-3 全景", writer.model_name)]
    # 子代理的描述随任务结束：disposedAt 就是任务的 endedAt。
    assert [(agent.agent_id, agent.type, agent.disposed_at) for agent in live.agents] == [
        (MAIN_AGENT_ID, "main", None),
        (child_id, "sub", live.tasks[0].ended_at),
    ]
    assert live.tasks[0].ended_at is not None
    _child_live, child_cold = await assert_child_stream(
        store, step_store, queue, runner, conversation_id, child_id, task=TASK
    )
    assert child_cold is not None

    row = await queue.get(prompt_id)
    assert row is not None and row.run_id is not None
    effect = await step_store.get_tool_effect(run_id=row.run_id, tool_call_id=card.tool_call_id)
    assert effect is not None and effect.effect_summary == child_id
    record = await step_store.get_run(run_id=child_id)
    assert record is not None
    assert (record.parent_run_id, record.metadata["agent_name"]) == (row.run_id, WRITER)
    check_golden("delegate-turn", {"rest": comparable(cold), "child_rest": comparable(child_cold)})


async def test_two_delegations_in_one_response_do_not_cross(
    engine: AsyncEngine, tmp_path: Path
) -> None:
    store = TranscriptStore()
    runner, step_store, queue = subagent_runner(
        engine,
        tmp_path,
        store=store,
        parent=delegates((WRITER, TASK), (COPY, "写一句文案")),
        children={WRITER: says("镜头一、镜头二"), COPY: says("一句文案")},
    )
    conversation_id = new_conversation_id()

    await submit_text(runner, queue, conversation_id, "分镜和文案一起来")
    await drained(queue, conversation_id)
    await runner.shutdown()
    live, _cold = await both_pages(store, step_store, queue, runner, conversation_id)

    cards = [frame for frame in frames_of(live, "t1", "t1.1") if isinstance(frame, ToolFrame)]
    by_name = {_args(card)["agent_name"]: card for card in cards}
    assert set(by_name) == {WRITER, COPY}
    tasks = {task.task_id: task for task in live.tasks}
    for name, said_text, task_text in (
        (WRITER, "镜头一、镜头二", TASK),
        (COPY, "一句文案", "写一句文案"),
    ):
        card = by_name[name]
        assert card.agent_refs is not None
        child_id = card.agent_refs[0].agent_id
        assert (tasks[child_id].description, tasks[child_id].result_summary) == (name, said_text)
        await assert_child_stream(
            store, step_store, queue, runner, conversation_id, child_id, task=task_text
        )
    assert len({card.agent_refs[0].agent_id for card in cards if card.agent_refs}) == 2


async def test_stopping_the_parent_kills_the_child(engine: AsyncEngine, tmp_path: Path) -> None:
    entered = asyncio.Event()
    store = TranscriptStore()
    runner, step_store, queue = subagent_runner(
        engine,
        tmp_path,
        store=store,
        parent=delegates((WRITER, TASK)),
        children={WRITER: hangs(entered)},
    )
    conversation_id = new_conversation_id()

    prompt_id = await submit_text(runner, queue, conversation_id, "给这条视频做分镜")
    await entered.wait()
    await runner.abort(conversation_id, prompt_id)
    await drained(queue, conversation_id)
    await runner.shutdown()
    live, _cold = await both_pages(store, step_store, queue, runner, conversation_id)

    assert [turn.state for turn in live.items] == ["cancelled"]
    assert [task.state for task in live.tasks] == ["killed"]
    card = frames_of(live, "t1", "t1.1")[0]
    assert isinstance(card, ToolFrame) and card.agent_refs is not None
    # 子运行在它的第一个响应里就被停了，快照里没有它，冷侧读不到；这条边界与主 agent 相同。
    await assert_child_stream(
        store,
        step_store,
        queue,
        runner,
        conversation_id,
        card.agent_refs[0].agent_id,
        task=TASK,
        state="cancelled",
        cold=False,
    )


def _spec(root: Path, name: str) -> Path:
    folder = root / name
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / "agent.yaml"
    path.write_text("model: test\n", encoding="utf-8")
    return path


def subagent_runner(
    engine: AsyncEngine,
    root: Path,
    *,
    store: TranscriptStore,
    parent: FunctionModel,
    children: dict[str, FunctionModel],
) -> tuple[ConversationRunner, PgStepStore, JobQueue]:
    """按真实装配路径建一个带子代理的主 agent，再按生产接法装 runner。"""

    step_store = PgStepStore(engine)
    models: dict[str, Any] = {AGENT_ID: parent, **children}
    definitions = (
        AgentDefinition(
            agent_id=AGENT_ID,
            spec=_spec(root, AGENT_ID),
            model=AGENT_ID,
            subagents=tuple(
                SubAgentDefinition(name=name, spec=_spec(root, name), model=name)
                for name in children
            ),
        ),
    )
    registry = build_agent_registry(
        definitions,
        step_store=step_store,
        usage_ledger=discarding_usage_ledger(),
        models=models,
        subagent_mirror=SubAgentMirror(
            live=store, display=DISPLAYS, profiles=subagent_profiles(definitions, models)
        ),
    )
    return make_runner(
        engine,
        agents=registry.agents,
        step_store=step_store,
        store=store,
        display=DISPLAYS,
        context_limits={},
    )


async def assert_child_stream(
    store: TranscriptStore,
    step_store: PgStepStore,
    queue: JobQueue,
    runner: ConversationRunner,
    conversation_id: str,
    child_id: str,
    *,
    task: str,
    state: str = "completed",
    cold: bool = True,
) -> tuple[TranscriptPage, TranscriptPage | None]:
    """子代理那条流：按它的 id 走同一个 REST 接口，实时重放与刷新后重建逐字相等，且只有以任务文本开头的 t1。

    cold=False 只看实时那份：子运行没落过快照时刷新后读不到，与主 agent 首个响应期间被停的边界相同。
    """

    live = await live_page(
        store,
        conversation_id,
        child_id,
        queue=queue,
        runner=runner,
        display=DISPLAYS,
        runtime_agent_id=AGENT_ID,
    )
    assert [(turn.turn_id, turn.state, turn.content) for turn in live.items] == [
        ("t1", state, (TextContent(text=task),))
    ]
    if not cold:
        return live, None
    rebuilt = await cold_page(
        step_store,
        conversation_id,
        child_id,
        queue=queue,
        runner=runner,
        display=DISPLAYS,
        runtime_agent_id=AGENT_ID,
        delegate_tool=DELEGATE_TOOL,
    )
    assert_same_page(live, rebuilt)
    return live, rebuilt


# --- 更多假模型 -----------------------------------------------------------------


def reads_then_hangs(entered: asyncio.Event) -> FunctionModel:
    """第一步读文件，第二步说半句就卡住。先过一个节点边界，这半句才会落进中断快照。"""

    asked = 0

    async def stream(
        _messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        nonlocal asked
        asked += 1
        if asked == 1:
            yield {
                0: DeltaToolCall(
                    name="Read", json_args='{"path": "brief.md"}', tool_call_id="call_read"
                )
            }
            return
        yield "想到一半"
        entered.set()
        await asyncio.sleep(30)
        yield "来不及了"

    return FunctionModel(stream_function=stream)


def reads_then_explodes(reason: str) -> FunctionModel:
    """第一步读文件，第二步说半句就炸。"""

    asked = 0

    async def stream(
        _messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        nonlocal asked
        asked += 1
        if asked == 1:
            yield {
                0: DeltaToolCall(
                    name="Read", json_args='{"path": "brief.md"}', tool_call_id="call_read"
                )
            }
            return
        yield "刚开口"
        raise RuntimeError(reason)

    return FunctionModel(stream_function=stream)


def waits_then_says(
    entered: asyncio.Event, gate: asyncio.Event, first: str, second: str
) -> FunctionModel:
    """首个请求卡在门上等插话进来，之后各答一句。"""

    asked = 0

    async def stream(
        _messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        nonlocal asked
        asked += 1
        if asked == 1:
            entered.set()
            await gate.wait()
            yield first
        else:
            yield second

    return FunctionModel(stream_function=stream)


def hangs(entered: asyncio.Event) -> FunctionModel:
    """子代理用：说了半句就卡住，等父运行来停它。"""

    async def stream(
        _messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        yield "想到一半"
        entered.set()
        await asyncio.sleep(30)
        yield "来不及了"

    return FunctionModel(stream_function=stream)
