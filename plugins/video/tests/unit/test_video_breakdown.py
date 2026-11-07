from __future__ import annotations

import inspect
import uuid
from collections.abc import Sequence

import httpx
import pytest
from cue.file_store.store import FileSpace
from cue.harness.background import is_receipt, parse_outcome
from cue.plugins.workspace.scope import workspace_namespace
from cue.run_deps import AgentRunDeps
from pydantic_ai import Agent, ModelRetry, ToolFailed
from pydantic_ai.messages import (
    ModelMessage,
    ModelResponse,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.models.test import TestModel
from pydantic_ai.tools import RunContext
from pydantic_ai.usage import RunUsage

from iclip_video.video_breakdown.capability import (
    BREAKDOWN_RETRIES,
    VideoBreakdown,
    VideoBreakdownPlugin,
    VideoBreakdownToolset,
    breakdown_doc_path,
)
from iclip_video.video_breakdown.ports import BreakdownFailureReason, FailedBreakdown
from tests.helpers.file_store import FakeFileStore
from tests.helpers.media_probe import Answer, ScriptedMedia

USER = uuid.UUID("11111111-1111-1111-1111-111111111111")
VIDEO = "https://cdn.test/ref.mp4"
NAMESPACE = f"{USER}/thread-1"
DOCUMENT = "# 出场元素\n……\n# 时间线\n……\n# 整片分析\n……"
PATH = breakdown_doc_path(VIDEO)
DONE = f"视频拆解完毕，文档在 {PATH}。"

UNREADABLE = "拆解失败，视频无法打开，不要重试，告诉用户换一条视频。"
CALL_AGAIN = "拆解失败，再调用一次。"
TRY_LATER = "拆解失败，不要重试，告诉用户稍后再试。"
ASK_AN_ADMIN = "拆解失败，拆解模型没有启用，不要重试，告诉用户需要管理员在配置页启用这个模型。"


class FakeBreakdowns:
    def __init__(self, *results: str | FailedBreakdown) -> None:
        self._results: Sequence[str | FailedBreakdown] = results or (DOCUMENT,)
        self.calls: list[tuple[uuid.UUID, str]] = []

    async def ensure(self, user_id: uuid.UUID, video_url: str) -> str | FailedBreakdown:
        self.calls.append((user_id, video_url))
        return self._results[min(len(self.calls), len(self._results)) - 1]


@pytest.fixture
def files() -> FakeFileStore:
    return FakeFileStore()


def make_deps() -> AgentRunDeps:
    return AgentRunDeps(user_id=USER, conversation_id="thread-1", user_name="logan")


def make_ctx(*, retry: int = 0) -> RunContext[object]:
    return RunContext[object](
        deps=make_deps(),
        model=TestModel(),
        usage=RunUsage(),
        messages=[],
        retry=retry,
        max_retries=BREAKDOWN_RETRIES,
    )


def capability_for(files: FakeFileStore, breakdowns: FakeBreakdowns) -> VideoBreakdown[object]:
    return VideoBreakdown[object](
        space=FileSpace(store=files, namespace=workspace_namespace), breakdowns=breakdowns
    )


def plugin_for(files: FakeFileStore, breakdowns: FakeBreakdowns) -> VideoBreakdownPlugin[object]:
    return (
        VideoBreakdownPlugin[object]
        .bind(space=FileSpace(store=files, namespace=workspace_namespace), breakdowns=breakdowns)
        .from_spec()
    )


def toolset(files: FakeFileStore, breakdowns: FakeBreakdowns) -> VideoBreakdownToolset[object]:
    return capability_for(files, breakdowns).get_toolset()


async def test_a_document_already_in_the_workspace_is_left_alone(files: FakeFileStore) -> None:
    await files.write(NAMESPACE, PATH, "用户指正过的文档")
    breakdowns = FakeBreakdowns()

    assert await toolset(files, breakdowns).breakdown_video(make_ctx(), VIDEO) == DONE

    stored = await files.read(NAMESPACE, PATH)
    assert stored is not None
    assert stored.content == "用户指正过的文档"
    assert breakdowns.calls == []


async def test_the_breakdown_is_asked_for_the_run_owner_and_written_as_is(
    files: FakeFileStore,
) -> None:
    breakdowns = FakeBreakdowns(DOCUMENT)

    assert await toolset(files, breakdowns).breakdown_video(make_ctx(), VIDEO) == DONE

    assert breakdowns.calls == [(USER, VIDEO)]
    stored = await files.read(NAMESPACE, PATH)
    assert stored is not None
    assert stored.content == DOCUMENT, "拆解原文原样保存"


@pytest.mark.parametrize(
    ("reason", "raised", "message"),
    [
        ("video_unreadable", ToolFailed, UNREADABLE),
        ("model_call_failed", ModelRetry, CALL_AGAIN),
        ("model_failed", ToolFailed, TRY_LATER),
        ("model_unavailable", ToolFailed, ASK_AN_ADMIN),
        ("timeout", ToolFailed, TRY_LATER),
    ],
)
async def test_each_failure_reason_gets_its_own_reply(
    files: FakeFileStore,
    reason: BreakdownFailureReason,
    raised: type[ModelRetry | ToolFailed],
    message: str,
) -> None:
    tools = toolset(files, FakeBreakdowns(FailedBreakdown(reason=reason)))

    with pytest.raises(raised) as caught:
        await tools.breakdown_video(make_ctx(), VIDEO)

    assert caught.value.message == message
    assert await files.read(NAMESPACE, PATH) is None


async def test_a_failed_model_call_on_the_last_attempt_is_final(files: FakeFileStore) -> None:
    tools = toolset(files, FakeBreakdowns(FailedBreakdown(reason="model_call_failed")))

    with pytest.raises(ToolFailed) as raised:
        await tools.breakdown_video(make_ctx(retry=BREAKDOWN_RETRIES), VIDEO)

    assert raised.value.message == TRY_LATER


async def run_agent_that_keeps_calling(capability: VideoBreakdown[object]) -> list[ModelMessage]:
    def script(messages: list[ModelMessage], _info: AgentInfo) -> ModelResponse:
        last = messages[-1].parts[-1]
        if len(messages) == 1 or (isinstance(last, ToolReturnPart) and last.outcome == "retried"):
            return call_breakdown(messages)
        return ModelResponse(parts=[TextPart("本轮结束。")])

    result = await Agent(FunctionModel(script), capabilities=[capability]).run(
        "拆解参考视频。", deps=make_deps()
    )
    return result.all_messages()


def call_breakdown(messages: list[ModelMessage]) -> ModelResponse:
    return ModelResponse(
        parts=[
            ToolCallPart("breakdown_video", {"video_url": VIDEO}, tool_call_id=f"c{len(messages)}")
        ]
    )


def tool_returns(messages: list[ModelMessage]) -> list[ToolReturnPart]:
    return [p for m in messages for p in m.parts if isinstance(p, ToolReturnPart)]


async def test_failed_model_calls_are_tried_four_times_and_the_run_survives(
    files: FakeFileStore,
) -> None:
    breakdowns = FakeBreakdowns(FailedBreakdown(reason="model_call_failed"))

    messages = await run_agent_that_keeps_calling(capability_for(files, breakdowns))

    assert len(breakdowns.calls) == 1 + BREAKDOWN_RETRIES
    returned = tool_returns(messages)
    retries = [part for part in returned if part.outcome == "retried"]
    assert len(retries) == BREAKDOWN_RETRIES
    (final,) = [part for part in returned if part.outcome != "retried"]
    assert TRY_LATER in final.model_response_str()


async def test_in_the_background_the_retry_budget_still_ends_in_a_final_failure(
    files: FakeFileStore,
) -> None:
    breakdowns = FakeBreakdowns(FailedBreakdown(reason="model_call_failed"))
    outcomes: list[tuple[str, str]] = []

    def script(messages: list[ModelMessage], _info: AgentInfo) -> ModelResponse:
        last = messages[-1].parts[-1]
        if len(messages) == 1:
            return call_breakdown(messages)
        if isinstance(last, UserPromptPart) and (outcome := parse_outcome(last)) is not None:
            outcomes.append((outcome.state, outcome.text))
            if outcome.text == CALL_AGAIN:
                return call_breakdown(messages)
        return ModelResponse(parts=[TextPart("本轮结束。")])

    result = await Agent(FunctionModel(script), capabilities=[plugin_for(files, breakdowns)]).run(
        "拆解参考视频。", deps=make_deps()
    )

    assert len(breakdowns.calls) == 1 + BREAKDOWN_RETRIES
    assert all(is_receipt(part) for part in tool_returns(result.all_messages()))
    assert outcomes == [("error", CALL_AGAIN)] * BREAKDOWN_RETRIES + [("error", TRY_LATER)]
    assert result.output == "本轮结束。"


async def test_a_retry_that_succeeds_delivers_the_document(files: FakeFileStore) -> None:
    breakdowns = FakeBreakdowns(FailedBreakdown(reason="model_call_failed"), DOCUMENT)

    messages = await run_agent_that_keeps_calling(capability_for(files, breakdowns))

    (final,) = [part for part in tool_returns(messages) if part.outcome != "retried"]
    assert final.model_response_str() == DONE
    assert len(breakdowns.calls) == 2
    stored = await files.read(NAMESPACE, PATH)
    assert stored is not None
    assert stored.content == DOCUMENT


async def test_the_address_must_be_http(files: FakeFileStore) -> None:
    validator = toolset(files, FakeBreakdowns()).tools["breakdown_video"].args_validator
    assert validator is not None, "breakdown_video 登记时没挂验证器"

    outcome = validator(make_ctx(), video_url="ref.mp4")
    assert inspect.isawaitable(outcome)
    with pytest.raises(ModelRetry, match="视频地址：打不开"):
        await outcome


@pytest.mark.parametrize(
    ("answer", "reason"),
    [
        pytest.param((404, None), "打不开", id="404"),
        pytest.param((503, None), "打不开", id="5xx"),
        pytest.param(httpx.ConnectError("连不上"), "打不开", id="连不上"),
        pytest.param(httpx.ReadTimeout("慢"), "打不开", id="超时"),
        pytest.param((200, "image/jpeg"), "不是视频", id="不是视频"),
    ],
)
async def test_a_wrong_video_address_never_reaches_the_backend(
    files: FakeFileStore, media: ScriptedMedia, answer: Answer, reason: str
) -> None:
    breakdowns = FakeBreakdowns()
    media.set(VIDEO, answer)

    def call_once(messages: list[ModelMessage], _info: AgentInfo) -> ModelResponse:
        if len(messages) == 1:
            return call_breakdown(messages)
        return ModelResponse(parts=[TextPart("本轮结束。")])

    result = await Agent(
        FunctionModel(call_once), capabilities=[capability_for(files, breakdowns)]
    ).run("拆解参考视频。", deps=make_deps())
    messages = result.all_messages()

    retried = [part for part in tool_returns(messages) if part.outcome == "retried"]
    assert retried
    assert f"视频地址：{reason}" in retried[0].model_response_str()
    assert VIDEO not in retried[0].model_response_str()
    assert breakdowns.calls == []


async def test_a_reachable_video_never_seen_in_the_conversation_is_taken(
    files: FakeFileStore, media: ScriptedMedia
) -> None:
    from_mcp = "https://mcp.example.com/blob/9c1e"
    media.set(from_mcp, (200, "video/mp4"))

    await check_video(toolset(files, FakeBreakdowns()), from_mcp)

    assert media.asked == [from_mcp]


async def check_video(tools: VideoBreakdownToolset[object], url: str) -> None:
    validator = tools.tools["breakdown_video"].args_validator
    assert validator is not None
    outcome = validator(make_ctx(), video_url=url)
    assert inspect.isawaitable(outcome)
    await outcome


def test_documents_of_two_videos_with_the_same_name_do_not_collide() -> None:
    assert breakdown_doc_path("https://a.test/ref.mp4") != breakdown_doc_path(
        "https://b.test/ref.mp4"
    )
    assert PATH.startswith("references/ref-")
    assert PATH.endswith(".md")
