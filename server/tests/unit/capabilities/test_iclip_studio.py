"""验证视频拆解工具：工作区已有的那份照用，否则交给参考视频的拆解并写进工作区；四种失败原因各自
给模型对的回复，重试次数用完给终局失败。"""

from __future__ import annotations

import inspect
import uuid
from collections.abc import Sequence

import pytest
from pydantic_ai import Agent, ModelRetry, ToolFailed
from pydantic_ai.messages import (
    ModelMessage,
    ModelResponse,
    RetryPromptPart,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
)
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.models.test import TestModel
from pydantic_ai.tools import RunContext
from pydantic_ai.usage import RunUsage

from iclip.capabilities.iclip_studio.capability import (
    BREAKDOWN_RETRIES,
    IclipStudio,
    IclipStudioToolset,
    breakdown_doc_path,
)
from iclip.capabilities.iclip_studio.ports import BreakdownFailureReason, FailedBreakdown
from iclip.capabilities.workspace.scope import workspace_namespace
from iclip.domains.agents.public import AgentRunDeps
from iclip.domains.identity.models import Principal
from iclip.platform.file_store.store import FileSpace
from iclip.platform.transcript.display import GenericDisplay
from tests.helpers.file_store import FakeFileStore
from tests.helpers.material_ledger import FakeMaterialLedger

USER = uuid.UUID("11111111-1111-1111-1111-111111111111")
VIDEO = "https://cdn.test/ref.mp4"
NAMESPACE = f"{USER}/thread-1"
DOCUMENT = "# 出场元素\n……\n# 时间线\n……\n# 整片分析\n……"
PATH = breakdown_doc_path(VIDEO)
DONE = f"视频拆解完毕，文档在 {PATH}。"

UNREADABLE = "拆解失败，视频无法打开，不要重试，告诉用户换一条视频。"
CALL_AGAIN = "拆解失败，再调用一次。"
TRY_LATER = "拆解失败，不要重试，告诉用户稍后再试。"

PRINCIPAL = Principal(
    kind="user",
    user_id=USER,
    permissions=frozenset({"agent:run"}),
    audit_label="logan",
    api_key_id=None,
)


class FakeBreakdowns:
    """参考视频拆解的替身：按顺序交出给定的结果，最后一个一直重复；记下每次是谁要的哪条视频。"""

    def __init__(self, *results: str | FailedBreakdown) -> None:
        self._results: Sequence[str | FailedBreakdown] = results or (DOCUMENT,)
        self.calls: list[tuple[Principal, str]] = []

    async def ensure(self, principal: Principal, video_url: str) -> str | FailedBreakdown:
        self.calls.append((principal, video_url))
        return self._results[min(len(self.calls), len(self._results)) - 1]


@pytest.fixture
def files() -> FakeFileStore:
    return FakeFileStore()


def make_deps() -> AgentRunDeps:
    return AgentRunDeps(principal=PRINCIPAL, conversation_id="thread-1", user_name="logan")


def make_ctx(*, retry: int = 0) -> RunContext[object]:
    """第 ``retry`` 次重试时的运行上下文；预算与工具登记的一致。"""

    return RunContext[object](
        deps=make_deps(),
        model=TestModel(),
        usage=RunUsage(),
        messages=[],
        retry=retry,
        max_retries=BREAKDOWN_RETRIES,
    )


def capability_for(files: FakeFileStore, breakdowns: FakeBreakdowns) -> IclipStudio[object]:
    return IclipStudio[object](
        space=FileSpace(store=files, namespace=workspace_namespace),
        breakdowns=breakdowns,
        ledger=FakeMaterialLedger(),
    )


def toolset(files: FakeFileStore, breakdowns: FakeBreakdowns) -> IclipStudioToolset[object]:
    return capability_for(files, breakdowns).get_toolset()


async def test_a_document_already_in_the_workspace_is_left_alone(files: FakeFileStore) -> None:
    """用户指正过的文档不被参考视频里的那份盖掉，也不再去要拆解。"""

    await files.write(NAMESPACE, PATH, "用户指正过的文档")
    breakdowns = FakeBreakdowns()

    assert await toolset(files, breakdowns).breakdown_video(make_ctx(), VIDEO) == DONE

    stored = await files.read(NAMESPACE, PATH)
    assert stored is not None
    assert stored.content == "用户指正过的文档"
    assert breakdowns.calls == []


async def test_the_breakdown_is_asked_for_the_run_principal_and_written_as_is(
    files: FakeFileStore,
) -> None:
    breakdowns = FakeBreakdowns(DOCUMENT)

    assert await toolset(files, breakdowns).breakdown_video(make_ctx(), VIDEO) == DONE

    assert breakdowns.calls == [(PRINCIPAL, VIDEO)]
    stored = await files.read(NAMESPACE, PATH)
    assert stored is not None
    assert stored.content == DOCUMENT, "拆解原文原样保存"


@pytest.mark.parametrize(
    ("reason", "raised", "message"),
    [
        ("video_unreadable", ToolFailed, UNREADABLE),
        ("model_call_failed", ModelRetry, CALL_AGAIN),
        ("model_failed", ToolFailed, TRY_LATER),
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


async def run_agent_that_keeps_calling(capability: IclipStudio[object]) -> list[ModelMessage]:
    """模型每次收到重试提示就原样再调一次，直到拿到工具结果。"""

    def script(messages: list[ModelMessage], _info: AgentInfo) -> ModelResponse:
        last = messages[-1].parts[-1]
        if len(messages) == 1 or isinstance(last, RetryPromptPart):
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        "breakdown_video", {"video_url": VIDEO}, tool_call_id=f"c{len(messages)}"
                    )
                ]
            )
        return ModelResponse(parts=[TextPart("本轮结束。")])

    result = await Agent(FunctionModel(script), capabilities=[capability]).run(
        "拆解参考视频。", deps=make_deps()
    )
    return result.all_messages()


async def test_failed_model_calls_are_tried_four_times_and_the_run_survives(
    files: FakeFileStore,
) -> None:
    """首次加三次重试，每次都去要一次拆解；预算用完后模型拿到的是失败结果，整次运行不被中止。"""

    breakdowns = FakeBreakdowns(FailedBreakdown(reason="model_call_failed"))

    messages = await run_agent_that_keeps_calling(capability_for(files, breakdowns))

    assert len(breakdowns.calls) == 1 + BREAKDOWN_RETRIES
    retries = [p for m in messages for p in m.parts if isinstance(p, RetryPromptPart)]
    assert len(retries) == BREAKDOWN_RETRIES
    (final,) = [p for m in messages for p in m.parts if isinstance(p, ToolReturnPart)]
    assert TRY_LATER in final.model_response_str()


async def test_a_retry_that_succeeds_delivers_the_document(files: FakeFileStore) -> None:
    breakdowns = FakeBreakdowns(FailedBreakdown(reason="model_call_failed"), DOCUMENT)

    messages = await run_agent_that_keeps_calling(capability_for(files, breakdowns))

    (final,) = [p for m in messages for p in m.parts if isinstance(p, ToolReturnPart)]
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
    with pytest.raises(ModelRetry) as raised:
        await outcome
    assert raised.value.message == "视频地址不对，输入提供的视频的 url。"


def test_documents_of_two_videos_with_the_same_name_do_not_collide() -> None:
    assert breakdown_doc_path("https://a.test/ref.mp4") != breakdown_doc_path(
        "https://b.test/ref.mp4"
    )
    assert PATH.startswith("references/ref-")
    assert PATH.endswith(".md")


def test_the_tool_card_names_the_video(files: FakeFileStore) -> None:
    draw = capability_for(files, FakeBreakdowns()).display_table()["breakdown_video"]
    assert callable(draw)

    assert draw({"video_url": VIDEO}) == GenericDisplay(summary="拆解视频", detail="ref.mp4")
