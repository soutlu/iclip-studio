"""验证压缩边界保留完整历史，仅在模型请求时生成压缩窗口。"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from pydantic_ai import Agent
from pydantic_ai.messages import (
    CompactionPart,
    InstructionDeltaPart,
    LoadCapabilityCallPart,
    LoadCapabilityReturnPart,
    ModelMessage,
    ModelRequest,
    ModelResponse,
    TextPart,
    ToolCallPart,
    UserPromptPart,
)
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai_harness.compaction import SummarizingCompaction
from pydantic_ai_harness.compaction._capability_loads import (  # 契约：harness 补记加载的私有标记
    RECORDED_LOAD_METADATA_KEY,
)
from pydantic_ai_harness.compaction._summary import (  # 契约：harness 认摘要的私有规则
    SUMMARY_METADATA_KEY,
    SUMMARY_TIME_METADATA_KEY,
    is_summary_part,
)
from pydantic_ai_harness.step_persistence import InMemoryStepStore, StepPersistence

from iclip.harness.context_compaction import (
    ContextCompaction,
    compaction_boundary,
    compaction_window,
    recorded_loads,
)
from iclip.harness.skills import build_skill_capabilities
from iclip.harness.transcript.from_messages import turns_from_messages
from iclip.harness.transcript.projector import step_responses
from iclip.platform.transcript.ops import TextContent

pytestmark = pytest.mark.unit

SUMMARY = "## Intent\n把 README 翻成英文"

MARKED: dict[str, Any] = {
    SUMMARY_METADATA_KEY: True,
    SUMMARY_TIME_METADATA_KEY: "2026-09-03T10:09:00+00:00",
}
"""摘要器写在摘要 part 上的 metadata；边界原样带着，窗口头部的摘要靠它被认作上一份摘要。"""


def _at(minute: int) -> datetime:
    return datetime(2026, 9, 3, 10, minute, tzinfo=UTC)


def _ask(text: str, *, run_id: str = "run-a", minute: int = 0) -> ModelRequest:
    return ModelRequest(parts=[UserPromptPart(content=text)], run_id=run_id, timestamp=_at(minute))


def _reply(text: str, *, run_id: str = "run-a", minute: int = 1) -> ModelResponse:
    return ModelResponse(parts=[TextPart(content=text)], run_id=run_id, timestamp=_at(minute))


def _summary_head(message: ModelMessage) -> CompactionPart:
    """窗口头部只含一个请求侧摘要：不带 provider，harness 认得出它是摘要器写的那份。"""

    assert isinstance(message, ModelRequest)
    (part,) = message.parts
    assert isinstance(part, CompactionPart)
    assert part.provider_name is None
    assert is_summary_part(part)
    return part


def _boundary(summary: str = SUMMARY, *, run_id: str = "run-a", minute: int = 9) -> ModelResponse:
    return ModelResponse(
        parts=[CompactionPart(content=summary, provider_name="function", metadata=MARKED)],
        run_id=run_id,
        timestamp=_at(minute),
    )


def test_没有边界时窗口就是整份历史() -> None:
    messages: list[ModelMessage] = [_ask("一"), _reply("二"), _ask("三")]

    assert compaction_window(messages) == messages


def test_有边界时窗口是摘要加边界之后那几条() -> None:
    tail = _ask("三")
    window = compaction_window([_ask("一"), _reply("二"), _boundary(), tail])

    # 请求侧摘要由框架包装成用户身份的摘要文字，排在 instructions 之后。
    head = _summary_head(window[0])
    assert (head.content, head.metadata) == (SUMMARY, MARKED)
    assert window[1:] == [tail]


def test_两条边界只认最后一条() -> None:
    tail = _ask("四")
    window = compaction_window(
        [_ask("一"), _boundary("旧摘要", minute=5), _reply("二"), _boundary("新摘要"), tail]
    )

    assert _summary_head(window[0]).content == "新摘要"
    assert window[1:] == [tail]


def test_边界和旁边那次响应并成一条时照样认得出() -> None:
    """同角色消息会合并，需按 part 识别边界，并保留同一消息中边界后的内容。"""

    tail = _ask("四")
    merged = ModelResponse(
        parts=[
            CompactionPart(content=SUMMARY, provider_name="function", metadata=MARKED),
            TextPart(content="答三"),
        ],
        run_id="run-a",
        timestamp=_at(9),
    )
    window = compaction_window([_ask("一"), _reply("二"), merged, tail])

    assert _summary_head(window[0]).content == SUMMARY
    kept = window[1]
    assert isinstance(kept, ModelResponse)
    assert kept.parts == [TextPart(content="答三")]
    assert window[2:] == [tail]


def test_空parts的响应不是边界() -> None:
    """all([]) 为真；必须排除空响应，避免误认压缩边界。"""

    assert compaction_boundary(ModelResponse(parts=[])) is None


def _model(seen: list[list[ModelMessage]]) -> FunctionModel:
    """以 <messages> 标记区分摘要请求与对话请求。"""

    def script(messages: list[ModelMessage], _info: AgentInfo) -> ModelResponse:
        seen.append(messages)
        return ModelResponse(parts=[TextPart(SUMMARY if _is_summary_call(messages) else "好了")])

    return FunctionModel(script)


def _is_summary_call(messages: list[ModelMessage]) -> bool:
    return any(
        isinstance(part, UserPromptPart) and "<messages>" in str(part.content)
        for message in messages
        for part in getattr(message, "parts", ())
    )


def _history(rounds: int) -> list[ModelMessage]:
    messages: list[ModelMessage] = []
    for index in range(rounds):
        messages.append(_ask(f"问{index}", run_id=f"run-{index}", minute=index * 2))
        messages.append(_reply(f"答{index}", run_id=f"run-{index}", minute=index * 2 + 1))
    return messages


def _agent(*, max_tokens: int, keep_messages: int, store: InMemoryStepStore) -> Agent[None, str]:
    return Agent(
        _model([]),
        capabilities=[
            ContextCompaction(
                strategy=SummarizingCompaction(
                    max_messages=1, keep_messages=keep_messages, preserve_first_user_message=False
                ),
                max_tokens=max_tokens,
                on_compaction=lambda _summary, _records: None,
            ),
            StepPersistence(store=store),
        ],
    )


async def _latest(store: InMemoryStepStore) -> list[ModelMessage]:

    runs = await store.list_runs()
    snapshot = await store.latest_snapshot(run_id=runs[-1].run_id)
    assert snapshot is not None
    return list(snapshot.messages)


def _turn_shape(messages: list[ModelMessage]) -> list[tuple[str, list[str]]]:
    return [
        (turn.turn_id, [step.step_id for step in turn.steps])
        for turn in turns_from_messages(messages)
    ]


def _notice_ids(messages: list[ModelMessage]) -> list[str]:
    return [
        frame.frame_id
        for turn in turns_from_messages(messages)
        for step in turn.steps
        for frame in step.frames
        if frame.kind == "notice"
    ]


async def _run(
    *, max_tokens: int, keep_messages: int, history: list[ModelMessage]
) -> tuple[list[str], list[list[ModelMessage]], list[ModelMessage], InMemoryStepStore]:
    """返回回调摘要、模型实际输入、完整历史和快照库。"""

    summaries: list[str] = []
    seen: list[list[ModelMessage]] = []
    store = InMemoryStepStore()
    agent = Agent(
        _model(seen),
        capabilities=[
            ContextCompaction(
                strategy=SummarizingCompaction(
                    max_messages=1, keep_messages=keep_messages, preserve_first_user_message=False
                ),
                max_tokens=max_tokens,
                on_compaction=lambda summary, _records: summaries.append(summary),
            ),
            StepPersistence(store=store),
        ],
    )
    result = await agent.run("接着做", message_history=history)
    return summaries, seen, result.all_messages(), store


def _boundaries(messages: list[ModelMessage]) -> list[ModelResponse]:
    return [
        message
        for message in messages
        if isinstance(message, ModelResponse) and compaction_boundary(message) is not None
    ]


async def test_没到线不压() -> None:
    summaries, seen, history, _ = await _run(
        max_tokens=1_000_000, keep_messages=2, history=_history(3)
    )

    assert summaries == []
    assert _boundaries(history) == []
    assert len(seen) == 1


async def test_过线就在切点插一条边界() -> None:
    prior = _history(4)
    summaries, _, history, _ = await _run(max_tokens=1, keep_messages=2, history=prior)

    boundaries = _boundaries(history)
    assert len(boundaries) == 1
    part = compaction_boundary(boundaries[0])
    assert part is not None
    assert (part.content, part.provider_name) == (SUMMARY, "function")
    # 摘要器写的标记与写成时间原样留在边界上。
    assert part.metadata is not None
    assert part.metadata[SUMMARY_METADATA_KEY] is True
    assert datetime.fromisoformat(part.metadata[SUMMARY_TIME_METADATA_KEY]).tzinfo is not None
    # 边界继承切点消息的 run_id，避免合并后将历史响应归入本轮。
    assert boundaries[0].run_id == prior[-1].run_id
    assert history[history.index(boundaries[0]) + 1] == prior[-1]
    assert summaries == [SUMMARY]


async def test_模型只收到窗口那几条() -> None:
    _, seen, history, _ = await _run(max_tokens=1, keep_messages=2, history=_history(4))

    sent = seen[-1]
    boundary = _boundaries(history)[0]
    head = _summary_head(sent[0])
    part = compaction_boundary(boundary)
    assert part is not None
    assert (head.content, head.metadata) == (part.content, part.metadata)
    assert sent[1:] == history[history.index(boundary) + 1 : -1]


async def test_没到线时模型也只收到上次边界之后那几条() -> None:
    """两次压缩之间不触发压缩的请求同样要裁剪，否则会发出完整历史。"""

    _, _, first, _ = await _run(max_tokens=1, keep_messages=2, history=_history(4))
    _, seen, history, _ = await _run(max_tokens=1_000_000, keep_messages=2, history=list(first))

    assert len(seen) == 1
    sent = seen[0]
    assert _summary_head(sent[0]).content == SUMMARY
    # 末条是本次模型的回复，不在发出的请求里；边界已与相邻响应合并，按窗口函数比对。
    assert sent[1:] == compaction_window(history[:-1])[1:]
    assert first[0] in history


async def test_快照存的是全量历史不是窗口() -> None:
    """持久化完整历史；模型窗口写回快照会导致旧轮内容丢失。"""

    prior = _history(4)
    _, _, history, store = await _run(max_tokens=1, keep_messages=2, history=prior)

    run_id = history[-1].run_id
    assert run_id is not None
    snapshot = await store.latest_snapshot(run_id=run_id)
    assert snapshot is not None
    assert snapshot.messages == history
    assert prior[0] in snapshot.messages
    assert len(_boundaries(list(snapshot.messages))) == 1


async def test_第二次压缩带着上一份摘要做增量() -> None:

    _, _, first, _ = await _run(max_tokens=1, keep_messages=2, history=_history(4))
    _, seen, _, _ = await _run(max_tokens=1, keep_messages=2, history=list(first))

    summary_calls = [messages for messages in seen if _is_summary_call(messages)]
    assert len(summary_calls) == 1
    prompt = "\n".join(
        str(part.content)
        for message in summary_calls[0]
        for part in getattr(message, "parts", ())
        if isinstance(part, UserPromptPart)
    )
    # 摘要器认出窗口头部的上一份摘要，把它作为增量的锚点放进 <previous-summary>。
    anchor = prompt.partition("<previous-summary>")[2].partition("</previous-summary>")[0]
    assert SUMMARY in anchor


async def test_切不动就不压也不回调() -> None:
    """保留尾部后无可摘要内容时，超出阈值也不执行压缩。"""

    summaries, seen, history, _ = await _run(max_tokens=1, keep_messages=20, history=_history(2))

    assert summaries == []
    assert _boundaries(history) == []
    assert len(seen) == 1


def test_补用量只认这次run的响应() -> None:
    """new_messages 可能包含边界后的历史响应，用量补充必须按当前 run_id 过滤。"""

    messages: list[ModelMessage] = [
        _boundary(run_id="run-b", minute=9),
        _reply("上一轮的话", run_id="run-a", minute=2),
        _ask("接着做", run_id="run-b", minute=10),
        _reply("这一轮的话", run_id="run-b", minute=11),
    ]

    assert step_responses(messages, "run-b") == [messages[-1]]


def test_不给run号时只摘掉边界() -> None:
    messages: list[ModelMessage] = [_boundary(), _ask("接着做"), _reply("这一轮的话")]

    assert step_responses(messages, None) == [messages[-1]]


async def test_压过之后老轮子的步一步不少() -> None:
    """框架合并边界和后续响应时保留前者 run_id；边界须使用切点 id，避免历史步骤改属本轮。"""

    store = InMemoryStepStore()
    agent = _agent(max_tokens=1, keep_messages=2, store=store)
    await agent.run("接着做", message_history=_history(4))
    first = await _latest(store)
    before = _turn_shape(first)

    # 复用压缩后的快照，并提高阈值避免第二轮再次压缩。
    later = InMemoryStepStore()
    await _agent(max_tokens=1_000_000, keep_messages=2, store=later).run(
        "再来", message_history=list(first)
    )
    second = await _latest(later)

    assert _turn_shape(second)[: len(before)] == before
    assert sum(1 for message in second if compaction_boundary(message) is not None) == 1
    assert _notice_ids(second) == _notice_ids(first)


# --- 按需加载的技能跨压缩 -------------------------------------------------------

SKILL = "demo"
SKILL_BODY = "按演示流程拆三组镜头"
LOAD_PROMPT = "先加载技能"


def _skill_library(root: Path) -> Path:
    (root / SKILL).mkdir()
    (root / SKILL / "SKILL.md").write_text(
        f"---\nname: {SKILL}\ndescription: 演示技能\n---\n\n{SKILL_BODY}\n", encoding="utf-8"
    )
    return root


def _skill_delivered(messages: list[ModelMessage]) -> bool:
    """框架把已加载技能的正文作为 capability 上下文放进用户侧 part 送达。"""

    return any(
        isinstance(part, UserPromptPart)
        and f'context id="capability:{SKILL}"' in str(part.content)
        and SKILL_BODY in str(part.content)
        for message in messages
        for part in message.parts
    )


def _skill_model(seen: list[tuple[str, list[ModelMessage]]]) -> FunctionModel:
    """首轮调 load_capability，其余一律回一句；摘要请求回固定摘要。"""

    def script(messages: list[ModelMessage], _info: AgentInfo) -> ModelResponse:
        if _is_summary_call(messages):
            return ModelResponse(parts=[TextPart(SUMMARY)])
        asked = next(
            (
                str(part.content)
                for part in messages[-1].parts
                if isinstance(part, UserPromptPart) and str(part.content) in _PROMPTS
            ),
            "",
        )
        seen.append((asked, messages))
        if asked == LOAD_PROMPT:
            return ModelResponse(
                parts=[ToolCallPart("load_capability", {"id": SKILL}, tool_call_id="load-1")]
            )
        return ModelResponse(parts=[TextPart("好了")])

    return FunctionModel(script)


_SETUP = (LOAD_PROMPT, "第二轮", "第三轮")
_COMPACTING = ("压缩一", "压缩二")
_AFTER = "之后"
_PROMPTS = (*_SETUP, *_COMPACTING, _AFTER)


async def _skill_conversation(
    library: Path, keep: int
) -> tuple[list[ModelMessage], list[ModelMessage], list[tuple[str, list[ModelMessage]]]]:
    """先加载技能再聊两轮，接着两轮各压一次，最后不压再聊一轮。

    返回最终历史、第一次压缩那轮结束时的历史（下一轮开头框架合并相邻消息之前），以及模型每次收到的消息。
    """

    seen: list[tuple[str, list[ModelMessage]]] = []
    history: list[ModelMessage] = []
    first_compacted: list[ModelMessage] = []
    for prompt in _PROMPTS:
        agent = Agent(
            _skill_model(seen),
            capabilities=[
                *build_skill_capabilities(library, (SKILL,)),
                ContextCompaction(
                    strategy=SummarizingCompaction(
                        max_messages=1, keep_messages=keep, preserve_first_user_message=False
                    ),
                    max_tokens=1 if prompt in _COMPACTING else 1_000_000,
                    on_compaction=lambda _summary, _records: None,
                ),
            ],
        )
        history = (await agent.run(prompt, message_history=history)).all_messages()
        if prompt == _COMPACTING[0]:
            first_compacted = list(history)
    return history, first_compacted, seen


CUT_SHAPES = pytest.mark.parametrize(
    ("keep", "cut_before"),
    [(1, ModelRequest), (2, ModelResponse), (3, ModelRequest)],
    ids=["cut-before-last-request", "cut-before-response", "cut-before-earlier-request"],
)


@CUT_SHAPES
async def test_压缩后已加载的技能保持加载(
    tmp_path: Path, keep: int, cut_before: type[ModelMessage]
) -> None:
    history, first_compacted, seen = await _skill_conversation(_skill_library(tmp_path), keep)

    # 补记紧跟边界：调用一条响应、返回一条请求，返回带 harness 的补记标记，之后才是保留的首条消息。
    at = next(i for i, m in enumerate(first_compacted) if compaction_boundary(m) is not None)
    call, returned, kept = first_compacted[at + 1 : at + 4]
    (call_part,) = call.parts
    assert isinstance(call_part, LoadCapabilityCallPart)
    assert call_part.args == {"id": SKILL}
    assert set(recorded_loads([returned])) == {call_part.tool_call_id}
    assert isinstance(kept, cut_before)

    # 加载之后的每次请求（含两次压缩那两轮与之后不压的一轮）模型都收到技能正文。
    asked = [prompt for prompt, _ in seen]
    assert asked == [LOAD_PROMPT, "", *_PROMPTS[1:]]
    assert [_skill_delivered(messages) for _, messages in seen] == [False] + [True] * len(_PROMPTS)
    assert len(_boundaries(history)) == 2


@CUT_SHAPES
async def test_补记不改轮次与步骤也不反复补发技能正文(
    tmp_path: Path, keep: int, cut_before: type[ModelMessage]
) -> None:
    del cut_before
    history, _, _ = await _skill_conversation(_skill_library(tmp_path), keep)

    assert _turn_shape(history) == [
        (f"t{n}", [f"t{n}.1", f"t{n}.2"] if prompt == LOAD_PROMPT else [f"t{n}.1"])
        for n, prompt in enumerate(_PROMPTS, start=1)
    ]
    assert [
        "".join(item.text for item in turn.content if isinstance(item, TextContent))
        for turn in turns_from_messages(history)
    ] == list(_PROMPTS)
    # 加载排在重新送达正文的指令之后；排反了框架每次请求都会先撤下再补发一遍正文。
    assert not [
        part
        for message in history
        for part in message.parts
        if isinstance(part, InstructionDeltaPart) and part.content is None
    ]


def test_补记的加载交换不算模型步骤() -> None:
    """补记调用与边界合并后仍不计步，即使 run_id 正是这次运行。"""

    recorded = LoadCapabilityReturnPart(
        content={"message": "loaded"},
        tool_call_id="rec-1",
        metadata={RECORDED_LOAD_METADATA_KEY: True},
    )
    messages: list[ModelMessage] = [
        ModelResponse(
            parts=[
                CompactionPart(content=SUMMARY, provider_name="function", metadata=MARKED),
                LoadCapabilityCallPart(args={"id": SKILL}, tool_call_id="rec-1"),
            ],
            run_id="run-b",
            timestamp=_at(9),
        ),
        ModelRequest(parts=[recorded], run_id="run-b", timestamp=_at(9)),
        _ask("接着做", run_id="run-b", minute=10),
        _reply("这一轮的话", run_id="run-b", minute=11),
    ]

    assert step_responses(messages, "run-b") == [messages[-1]]
    assert [step.step_id for turn in turns_from_messages(messages) for step in turn.steps] == [
        "t1.1"
    ]
