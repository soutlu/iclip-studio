"""使用内存替身验证取帧与出图工具、生成重试、端口错误的转换与能力装配；查任务时后端不可达的两条经内部
接口的 HTTP 客户端走一趟。抽帧拼板与切格的媒体处理在宿主服务里，由那边的测试覆盖。"""

from __future__ import annotations

import inspect
import json
import uuid
from dataclasses import dataclass, replace
from typing import Any

import httpx
import pytest
from agent_runtime.file_store.store import FileSpace
from agent_runtime.material_ledger.store import Material
from agent_runtime.plugins.workspace.scope import workspace_namespace
from agent_runtime.run_deps import AgentRunDeps
from pydantic_ai import Agent, ModelRetry, ToolFailed
from pydantic_ai.messages import (
    ModelMessage,
    ModelResponse,
    TextPart,
    ToolCallPart,
    ToolReturn,
    ToolReturnPart,
)
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.models.test import TestModel
from pydantic_ai.tools import RunContext
from pydantic_ai.usage import RunUsage
from structlog.testing import capture_logs

from iclip_video.internal_api import HttpImageGenerations, InternalApi, InternalApiError
from iclip_video.shot_video.capability import (
    GenerationPolicy,
    ShotVideo,
)
from iclip_video.shot_video.delivery import FrameRequest
from iclip_video.shot_video.extraction import EXTRACTION_PATH
from iclip_video.shot_video.generation import (
    ANCHOR_ASPECT,
    GRID_RESOLUTION,
)
from iclip_video.shot_video.ports import (
    AnchorSheets,
    BoardsNotStored,
    BoardsUnreadable,
    FrameBoardsFailed,
    GridCutFailed,
    ShotCells,
    ShotsOutOfRange,
)
from iclip_video.shot_video.shots import parse_shot_rows
from iclip_video.shot_video.toolset import ShotVideoToolset
from iclip_video.video_document import video_doc_path
from tests.helpers.file_store import FakeFileStore
from tests.helpers.material_ledger import FakeMaterialLedger
from tests.helpers.plugins import with_requirements
from tests.helpers.shot_video import (
    FakeBoards,
    FakeCuts,
    FakeGenerations,
    Outcome,
    board_url,
    cut_url,
    mount_shot_video,
)

USER = uuid.UUID("11111111-1111-1111-1111-111111111111")
CONVERSATION = "33333333-3333-3333-3333-333333333333"
VIDEO = "https://cdn.test/ref.mp4"
NAMESPACE = f"{USER}/{CONVERSATION}"

DOCUMENT = (
    "## 4、逐镜拉片表\n"
    "| 结构层级 | Storyline |\n"
    "| Rain-Step Hook | **[00:00.000-00:02.000]** 中景……<br><br>"
    "**[00:02.000-00:04.000]** 特写…… |\n"
)

# 替身无网络或子进程操作，缩短轮询间隔以减少测试等待。
FAST = GenerationPolicy(
    poll_interval_seconds=0.001,
    dev_attempts=2,
    pro_attempts=1,
    backoff_seconds=0.001,
    backoff_factor=1.0,
    total_timeout_seconds=5.0,
)


def make_deps() -> AgentRunDeps:
    return AgentRunDeps(user_id=USER, conversation_id=CONVERSATION, user_name="logan")


def make_context(deps: object) -> RunContext[object]:

    return RunContext[object](deps=deps, model=TestModel(), usage=RunUsage(), messages=[])


def ledger(*_cell_ids: str, url: str | None = None) -> str:
    """取帧账本。逐格请求不校验帧号是否在账本里，出图工具只看它存不存在。"""

    return json.dumps(
        {
            "extractionVersion": 1,
            "extractionKey": "k",
            "boards": [{"board": 1, "url": url or board_url()}],
        }
    )


@pytest.fixture
def generations() -> FakeGenerations:
    return FakeGenerations()


@pytest.fixture
def boards() -> FakeBoards:
    return FakeBoards()


@pytest.fixture
def cuts() -> FakeCuts:
    return FakeCuts()


@pytest.fixture
def files() -> FakeFileStore:
    return FakeFileStore()


@pytest.fixture
def materials() -> FakeMaterialLedger:
    """模拟参考视频已在收件阶段登记。"""

    fake = FakeMaterialLedger()
    fake.rows[(NAMESPACE, VIDEO)] = Material(url=VIDEO, kind="video")
    return fake


@pytest.fixture
def capability(
    files: FakeFileStore,
    materials: FakeMaterialLedger,
    generations: FakeGenerations,
    boards: FakeBoards,
    cuts: FakeCuts,
) -> ShotVideo[object]:
    return mount_shot_video(
        space=FileSpace(store=files, namespace=workspace_namespace),
        ledger=materials,
        generations=generations,
        boards=boards,
        cuts=cuts,
        policy=FAST,
    )


@pytest.fixture
def tools(capability: ShotVideo[object]) -> ShotVideoToolset[object]:
    toolset = capability.get_toolset()
    assert isinstance(toolset, ShotVideoToolset)
    return toolset


@pytest.fixture
def ctx() -> RunContext[object]:
    return make_context(make_deps())


async def check_args(
    tools: ShotVideoToolset[object], name: str, ctx: RunContext[object], **args: Any
) -> None:
    """通过工具注册表调用校验器，覆盖 args_validator 的挂载遗漏。"""

    validator = tools.tools[name].args_validator
    assert validator is not None, f"{name} 登记时没挂验证器"
    outcome = validator(ctx, **args)
    assert inspect.isawaitable(outcome), "本包的验证器都是 async 的"
    await outcome


async def test_an_out_of_scope_address_is_refused_on_the_agent_path(
    capability: ShotVideo[object], files: FakeFileStore
) -> None:
    """通过真实 Agent 确认未登记地址在工具执行前被拒绝。"""

    def call_once(messages: list[ModelMessage], _info: AgentInfo) -> ModelResponse:
        if len(messages) == 1:
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        "plan_shot_frames",
                        {"video_url": "https://cdn.test/made-up.mp4"},
                        tool_call_id="c1",
                    )
                ]
            )
        return ModelResponse(parts=[TextPart("好")])

    agent = Agent(
        FunctionModel(call_once), capabilities=with_requirements(capability, capability.space)
    )
    result = await agent.run("帮我拆一下", deps=make_deps())

    refusals = [
        part
        for message in result.all_messages()
        for part in message.parts
        if isinstance(part, ToolReturnPart) and part.outcome == "retried"
    ]
    assert len(refusals) == 1
    assert "不是这段对话里的素材" in refusals[0].model_response_str()
    assert await files.entries(NAMESPACE) == []


async def test_missing_run_identity_is_a_bug_not_a_retry(tools: ShotVideoToolset[object]) -> None:
    """deps 类型错误属于装配故障，模型重试无法修复。"""

    with pytest.raises(RuntimeError, match="AgentRunDeps"):
        await tools.plan_shot_frames(make_context(object()), VIDEO)


@pytest.mark.parametrize("url", ["ref.mp4", "file:///etc/passwd", "ftp://host/a.mp4"])
async def test_tools_only_take_http_urls(
    tools: ShotVideoToolset[object], ctx: RunContext[object], url: str
) -> None:
    with pytest.raises(ModelRetry, match="http"):
        await check_args(tools, "plan_shot_frames", ctx, video_url=url)


async def test_plan_refuses_an_address_the_conversation_never_had(
    tools: ShotVideoToolset[object], ctx: RunContext[object]
) -> None:
    """素材范围校验必须先于视频下载，避免请求未登记的地址。"""

    with pytest.raises(ModelRetry, match="不是这段对话里的素材") as failure:
        await check_args(tools, "plan_shot_frames", ctx, video_url="https://cdn.test/made-up.mp4")

    # 不回显未登记地址，避免重试消息将其引入素材上下文。
    assert "made-up" not in str(failure.value)


async def test_plan_refuses_an_image_the_user_sent(
    tools: ShotVideoToolset[object], ctx: RunContext[object], materials: FakeMaterialLedger
) -> None:

    image = "https://cdn.test/poster.jpg"
    materials.rows[(NAMESPACE, image)] = Material(url=image, kind="image")
    with pytest.raises(ModelRetry, match="图片"):
        await check_args(tools, "plan_shot_frames", ctx, video_url=image)


async def test_reference_images_refuse_a_video(
    tools: ShotVideoToolset[object], ctx: RunContext[object]
) -> None:

    with pytest.raises(ModelRetry, match="视频"):
        await check_args(
            tools,
            "generate_shot_frames",
            ctx,
            frames=[FrameRequest(no="S1-1", prompt="猫")],
            reference_images=[VIDEO],
            global_reference="全局",
            target_aspect="9:16",
        )


async def test_reference_images_take_an_address_the_tools_wrote_down(
    tools: ShotVideoToolset[object], ctx: RunContext[object], materials: FakeMaterialLedger
) -> None:

    frame = "https://bucket.oss-ap-southeast-1.aliyuncs.com/shot-frames/k/S1-1.jpg"
    materials.rows[(NAMESPACE, frame)] = Material(url=frame, kind="image")

    async def call(url: str) -> None:
        await check_args(
            tools,
            "generate_shot_frames",
            ctx,
            frames=[FrameRequest(no="S1-1", prompt="猫")],
            reference_images=[url],
            global_reference="全局",
            target_aspect="9:16",
        )

    await call(frame)
    with pytest.raises(ModelRetry, match="不是这段对话里的素材"):
        await call("https://bucket.oss-ap-southeast-1.aliyuncs.com/shot-frames/k/S9-9.jpg")


async def test_plan_needs_the_document_first(
    tools: ShotVideoToolset[object], ctx: RunContext[object], boards: FakeBoards
) -> None:
    """缺少文档时在要预览板之前失败，不下载视频。"""

    with pytest.raises(ModelRetry, match="video_parser"):
        await tools.plan_shot_frames(ctx, VIDEO)
    assert boards.calls == []


async def test_plan_points_at_a_repair_the_model_can_perform(
    tools: ShotVideoToolset[object], ctx: RunContext[object], files: FakeFileStore
) -> None:

    await files.write(NAMESPACE, video_doc_path(VIDEO), "## 4、逐镜拉片表\n没有任何时间码\n")
    with pytest.raises(ModelRetry) as raised:
        await tools.plan_shot_frames(ctx, VIDEO)
    assert "edit_file" in str(raised.value)


async def test_plan_rejects_a_document_with_a_broken_timecode(
    tools: ShotVideoToolset[object],
    ctx: RunContext[object],
    files: FakeFileStore,
    boards: FakeBoards,
) -> None:
    """结束时间不晚于开始时间时无法取帧，应在下载和抽帧前拒绝。"""

    await files.write(NAMESPACE, video_doc_path(VIDEO), "**[00:05.000-00:02.000]** 中景")
    with pytest.raises(ModelRetry, match="终点不晚于起点"):
        await tools.plan_shot_frames(ctx, VIDEO)
    assert boards.calls == []


async def test_plan_writes_the_ledger_the_boards_port_built(
    tools: ShotVideoToolset[object],
    ctx: RunContext[object],
    files: FakeFileStore,
    materials: FakeMaterialLedger,
    boards: FakeBoards,
) -> None:
    """工作区里没有台账：交给端口的 previous 为空，端口建出的台账照原样落盘，板地址登记进素材台账。"""

    await files.write(NAMESPACE, video_doc_path(VIDEO), DOCUMENT)

    result = await tools.plan_shot_frames(ctx, VIDEO)

    [call] = boards.calls
    assert (call.video_url, call.rows, call.previous) == (VIDEO, parse_shot_rows(DOCUMENT), None)
    stored = await files.read(NAMESPACE, EXTRACTION_PATH)
    assert stored is not None
    assert json.loads(stored.content) == {
        "extractionVersion": 1,
        "extractionKey": "k",
        "boards": [{"board": 1, "url": board_url(1)}],
    }
    assert isinstance(result, ToolReturn)
    assert result.return_value == {
        "message": "取帧完成：共 1 个结构层级，组合成 1 组图片。"
        "每组图中每张视频帧左上的标注即帧号（S<镜头号>-<序号>）。",
        "boards": [{"board": 1, "shots": [1, 2], "url": board_url(1)}],
    }
    assert board_url(1) in materials.urls(NAMESPACE)


async def test_plan_hands_the_workspace_ledger_to_the_port_and_keeps_it_when_reused(
    tools: ShotVideoToolset[object],
    ctx: RunContext[object],
    files: FakeFileStore,
    boards: FakeBoards,
) -> None:
    """台账能否复用由端口判断；端口说复用，工作区里那份就不重写。"""

    await files.write(NAMESPACE, video_doc_path(VIDEO), DOCUMENT)
    original = ledger()
    await files.write(NAMESPACE, EXTRACTION_PATH, original)

    await tools.plan_shot_frames(ctx, VIDEO)

    [call] = boards.calls
    assert call.previous is not None
    assert [(board.board, board.url) for board in call.previous.boards] == [(1, board_url(1))]
    stored = await files.read(NAMESPACE, EXTRACTION_PATH)
    assert stored is not None
    assert stored.content == original


@pytest.mark.parametrize(
    "failure",
    [
        ShotsOutOfRange("镜头时间戳越界（视频时长 3000ms）：镜头 1。对着拆解文档核一遍。"),
        BoardsUnreadable("取不到素材（HTTPStatusError）: https://cdn.test/ref.mp4"),
        BoardsNotStored("图片没存进对象存储：Read timed out。重新调用一次。"),
    ],
    ids=["out-of-range", "unreadable", "not-stored"],
)
async def test_plan_hands_the_port_failure_to_the_model_word_for_word(
    tools: ShotVideoToolset[object],
    ctx: RunContext[object],
    files: FakeFileStore,
    boards: FakeBoards,
    failure: FrameBoardsFailed,
) -> None:
    await files.write(NAMESPACE, video_doc_path(VIDEO), DOCUMENT)
    boards.error = failure

    with pytest.raises(ModelRetry) as raised:
        await tools.plan_shot_frames(ctx, VIDEO)

    assert raised.value.message == str(failure)
    assert await files.read(NAMESPACE, EXTRACTION_PATH) is None


async def test_generate_needs_the_extraction_ledger(
    tools: ShotVideoToolset[object], ctx: RunContext[object], generations: FakeGenerations
) -> None:
    with pytest.raises(ModelRetry, match="plan_shot_frames"):
        await tools.generate_shot_frames(
            ctx, [FrameRequest(no="S1-1", prompt="猫")], [], "全局", "9:16"
        )
    assert generations.submitted == []


BROKEN_LEDGERS = {
    "not-json": "{",
    "board-without-url": json.dumps(
        {"extractionVersion": 1, "extractionKey": "k", "boards": [{"board": 1}]}
    ),
    "board-zero": json.dumps(
        {
            "extractionVersion": 1,
            "extractionKey": "k",
            "boards": [{"board": 0, "url": "https://cdn.test/board.jpg"}],
        }
    ),
    "board-as-text": json.dumps(
        {
            "extractionVersion": 1,
            "extractionKey": "k",
            "boards": [{"board": "1", "url": "https://cdn.test/board.jpg"}],
        }
    ),
}
"""模型改坏的取帧台账：key 仍然对得上，形状不合。"""


async def test_generate_treats_a_broken_ledger_as_missing(
    tools: ShotVideoToolset[object],
    ctx: RunContext[object],
    files: FakeFileStore,
    generations: FakeGenerations,
) -> None:
    await files.write(NAMESPACE, EXTRACTION_PATH, BROKEN_LEDGERS["board-without-url"])
    with pytest.raises(ModelRetry, match="plan_shot_frames"):
        await tools.generate_shot_frames(
            ctx, [FrameRequest(no="S1-1", prompt="猫")], [], "全局", "9:16"
        )
    assert generations.submitted == []


@pytest.mark.parametrize(
    ("frames", "expected"),
    [
        ([], "1-4"),
        ([FrameRequest(no=f"S1-{index}", prompt="猫") for index in range(1, 6)], "1-4"),
        ([FrameRequest(no="8-3", prompt="猫")], "形状"),
        ([FrameRequest(no="S1-1", prompt="猫"), FrameRequest(no="S1-1", prompt="狗")], "重复"),
        ([FrameRequest(no="S1-1", prompt="  ")], "为空"),
    ],
    ids=["empty", "too-many", "bad-shape", "duplicate", "blank-prompt"],
)
async def test_generate_checks_every_cell_before_paying(
    tools: ShotVideoToolset[object],
    ctx: RunContext[object],
    files: FakeFileStore,
    generations: FakeGenerations,
    frames: list[FrameRequest],
    expected: str,
) -> None:
    await files.write(NAMESPACE, EXTRACTION_PATH, ledger("S1-1", "S1-2", "S1-3", "S1-4"))
    with pytest.raises(ModelRetry, match=expected):
        await tools.generate_shot_frames(ctx, frames, [], "全局", "9:16")
    assert generations.submitted == []


async def test_generate_accepts_a_frame_the_ledger_never_sampled(
    tools: ShotVideoToolset[object],
    ctx: RunContext[object],
    files: FakeFileStore,
    generations: FakeGenerations,
) -> None:
    """新增镜头或不足一秒的镜头可能没有候选帧，仍应允许生成定格。"""

    generations.outcomes = [
        Outcome(status="failed", output_url=None, error_code="PROVIDER_REJECTED")
    ]
    await files.write(NAMESPACE, EXTRACTION_PATH, ledger("S1-1"))
    with pytest.raises(ToolFailed):
        await tools.generate_shot_frames(
            ctx, [FrameRequest(no="S9-2", prompt="猫")], [], "全局", "9:16"
        )
    assert generations.submitted


async def test_generate_tags_the_job_with_the_conversation(
    tools: ShotVideoToolset[object],
    files: FakeFileStore,
    generations: FakeGenerations,
) -> None:

    conversation_id = str(uuid.uuid4())
    ctx = make_context(replace(make_deps(), conversation_id=conversation_id))
    # 使用失败结果避免进入切格流程，本测试仅检查提交字段。
    generations.outcomes = [Outcome(status="failed", output_url=None, error_code="REJECTED")]
    await files.write(f"{USER}/{conversation_id}", EXTRACTION_PATH, ledger("S1-1"))
    with pytest.raises(ToolFailed):
        await tools.generate_shot_frames(
            ctx, [FrameRequest(no="S1-1", prompt="猫")], [], "全局", "9:16"
        )
    with pytest.raises(ToolFailed):
        await tools.generate_anchor_sheet(ctx, ["一只猫"])

    assert {request.conversation_id for request in generations.submitted} == {conversation_id}


async def test_a_conversation_id_that_is_not_a_uuid_is_corrupt_state(
    tools: ShotVideoToolset[object],
    files: FakeFileStore,
    generations: FakeGenerations,
) -> None:
    """入口已把对话 id 规范成 UUID，这里不是 UUID 属于状态损坏，不静默归档成空。"""

    ctx = make_context(replace(make_deps(), conversation_id="thread-1"))
    await files.write(f"{USER}/thread-1", EXTRACTION_PATH, ledger("S1-1"))
    with pytest.raises(RuntimeError, match="UUID") as failure:
        await tools.generate_shot_frames(
            ctx, [FrameRequest(no="S1-1", prompt="猫")], [], "全局", "9:16"
        )
    with pytest.raises(RuntimeError, match="UUID"):
        await tools.generate_anchor_sheet(ctx, ["一只猫"])

    assert "thread-1" not in str(failure.value)
    assert generations.submitted == []


async def test_generate_reference_urls_must_be_http(
    tools: ShotVideoToolset[object],
    ctx: RunContext[object],
    generations: FakeGenerations,
) -> None:
    with pytest.raises(ModelRetry, match="参考图"):
        await check_args(
            tools,
            "generate_shot_frames",
            ctx,
            frames=[FrameRequest(no="S1-1", prompt="猫")],
            reference_images=["grid.png"],
            global_reference="全局",
            target_aspect="9:16",
        )
    assert generations.submitted == []


async def test_generate_refuses_an_empty_global_reference(
    tools: ShotVideoToolset[object], ctx: RunContext[object], files: FakeFileStore
) -> None:
    await files.write(NAMESPACE, EXTRACTION_PATH, ledger("S1-1"))
    with pytest.raises(ModelRetry, match="global_reference"):
        await tools.generate_shot_frames(
            ctx, [FrameRequest(no="S1-1", prompt="猫")], [], "  ", "9:16"
        )


async def submit_once(
    tools: ShotVideoToolset[object], ctx: RunContext[object], files: FakeFileStore
) -> ToolFailed:
    """提交一次生成并捕获模型可见的失败，避免依赖 ffmpeg 切格。"""

    await files.write(NAMESPACE, EXTRACTION_PATH, ledger("S1-1"))
    with pytest.raises(ToolFailed) as failed:
        await tools.generate_shot_frames(
            ctx, [FrameRequest(no="S1-1", prompt="猫")], [], "全局参考", "9:16"
        )
    return failed.value


async def test_generate_submits_a_full_grid_at_the_top_tier(
    tools: ShotVideoToolset[object],
    ctx: RunContext[object],
    files: FakeFileStore,
    generations: FakeGenerations,
) -> None:
    """单格也使用完整四格网格；最高分辨率保证切分后单格尺寸。"""

    generations.outcomes = [
        Outcome(status="failed", output_url=None, error_code="PROVIDER_REJECTED")
    ]
    await submit_once(tools, ctx, files)
    request = generations.submitted[0]
    assert request.resolution == GRID_RESOLUTION
    assert request.aspect_ratio == "9:16"
    assert "全局参考" in request.prompt
    assert request.prompt.count("visual_prompt:") == 4


@pytest.mark.parametrize(
    "error_code",
    [
        "PROVIDER_UNREACHABLE",
        "PROVIDER_REJECTED",
        "PROVIDER_GENERATION_FAILED",
        "PROVIDER_RESULT_UNKNOWN",
        "PROVIDER_MALFORMED",
        "PROVIDER_OUTPUT_MISSING",
        "OUTPUT_STORE_FAILED",
        "OUTPUT_DOWNLOAD_FAILED",
        "SUBMIT_INTERRUPTED",
        "PROVIDER_TIMEOUT",
    ],
)
async def test_generate_walks_every_channel_on_any_failure(
    tools: ShotVideoToolset[object],
    ctx: RunContext[object],
    files: FakeFileStore,
    generations: FakeGenerations,
    error_code: str,
) -> None:

    generations.outcomes = [Outcome(status="failed", output_url=None, error_code=error_code)]
    result = await submit_once(tools, ctx, files)
    assert generations.channels() == ["dev", "dev", "pro"]
    assert error_code in result.message


async def test_generate_stays_on_dev_when_pro_is_off(
    ctx: RunContext[object],
    generations: FakeGenerations,
    files: FakeFileStore,
) -> None:

    generations.outcomes = [
        Outcome(status="failed", output_url=None, error_code="PROVIDER_REJECTED")
    ]
    toolset = mount_shot_video(
        space=FileSpace(store=files, namespace=workspace_namespace),
        ledger=FakeMaterialLedger(),
        generations=generations,
        boards=FakeBoards(),
        cuts=FakeCuts(),
        policy=replace(FAST, dev_attempts=2, pro_attempts=0),
    ).get_toolset()
    assert isinstance(toolset, ShotVideoToolset)
    result = await submit_once(toolset, ctx, files)
    assert generations.channels() == ["dev", "dev"]
    assert "PROVIDER_REJECTED" in result.message


async def test_generate_rejects_bad_parameters_before_paying(
    tools: ShotVideoToolset[object],
    ctx: RunContext[object],
    files: FakeFileStore,
    generations: FakeGenerations,
) -> None:
    """非法参数应在付费提交前拒绝，供模型修正。"""

    await files.write(NAMESPACE, EXTRACTION_PATH, ledger("S1-1"))
    with pytest.raises(ModelRetry, match="aspect_ratio"):
        await tools.generate_shot_frames(
            ctx, [FrameRequest(no="S1-1", prompt="猫")], [], "全局", "17:9"
        )
    assert generations.submitted == []


async def test_generate_timeout_is_a_brief_failure_and_logs_the_record(
    ctx: RunContext[object],
    generations: FakeGenerations,
    files: FakeFileStore,
) -> None:
    """超时对模型报告失败，诊断留日志；总时限耗尽后不新增生成。"""

    generations.outcomes = [Outcome(status="submitted", output_url=None)]
    toolset = mount_shot_video(
        space=FileSpace(store=files, namespace=workspace_namespace),
        ledger=FakeMaterialLedger(),
        generations=generations,
        boards=FakeBoards(),
        cuts=FakeCuts(),
        policy=replace(FAST, dev_attempts=1, pro_attempts=1, total_timeout_seconds=0.02),
    ).get_toolset()
    assert isinstance(toolset, ShotVideoToolset)
    with capture_logs() as logs:
        result = await submit_once(toolset, ctx, files)
    assert generations.channels() == ["dev"]
    assert "TOOL_WAIT_TIMEOUT" in result.message
    assert logs[-1]["error_code"] == "TOOL_WAIT_TIMEOUT"
    assert logs[-1]["job_id"] == str(generations.job_ids[0])


HTTP_JOB = uuid.UUID("44444444-4444-4444-4444-444444444444")


@dataclass
class PollingBackend:
    """经内部接口出图的后端替身：受理一次出图答 pending；查询按 ``polls`` 依次答或在传输层抛，
    用完后答完成。"""

    polls: list[httpx.Response | httpx.HTTPError]
    submissions: int = 0
    queries: int = 0

    def __call__(self, request: httpx.Request) -> httpx.Response:
        job: dict[str, Any] = {"job_id": str(HTTP_JOB), "channel": "dev"}
        if request.method == "POST":
            self.submissions += 1
            return httpx.Response(200, json={**job, "status": "pending"})
        self.queries += 1
        if self.polls:
            answer = self.polls.pop(0)
            if isinstance(answer, httpx.HTTPError):
                raise answer
            return answer
        return httpx.Response(200, json={**job, "status": "completed", "output_url": GRID})

    def tools(self, files: FakeFileStore, cuts: FakeCuts) -> ShotVideoToolset[object]:
        api = InternalApi(
            httpx.AsyncClient(transport=httpx.MockTransport(self), base_url="http://server.test")
        )
        toolset = mount_shot_video(
            space=FileSpace(store=files, namespace=workspace_namespace),
            ledger=FakeMaterialLedger(),
            generations=HttpImageGenerations(api),
            boards=FakeBoards(),
            cuts=cuts,
            policy=FAST,
        ).get_toolset()
        assert isinstance(toolset, ShotVideoToolset)
        return toolset


async def test_generate_keeps_polling_while_the_backend_restarts(
    ctx: RunContext[object], files: FakeFileStore, cuts: FakeCuts
) -> None:
    """查任务时后端重启（502/503、连不上）：已付费的任务还在跑，接着查到它完成，工具照常交回结果。"""

    backend = PollingBackend(
        polls=[
            httpx.Response(503, json={"detail": "Service Unavailable"}),
            httpx.ConnectError("connection refused"),
            httpx.Response(502, text="Bad Gateway"),
        ]
    )
    await files.write(NAMESPACE, EXTRACTION_PATH, ledger("S1-1"))

    with capture_logs() as logs:
        result = await backend.tools(files, cuts).generate_shot_frames(
            ctx, [FrameRequest(no="S1-1", prompt="猫")], [], "全局参考", "9:16"
        )

    assert result.return_value == {"frames": [{"no": "S1-1", "url": cut_url(HTTP_JOB, "S1-1")}]}
    assert (backend.submissions, backend.queries) == (1, 4)
    assert [log["job_id"] for log in logs if log["event"] == "查出图任务暂时失败"] == [
        str(HTTP_JOB)
    ] * 3


async def test_generate_reports_a_deterministic_poll_failure(
    ctx: RunContext[object], files: FakeFileStore, cuts: FakeCuts
) -> None:
    """查任务答 404 之类不是暂时的：照旧报错，不接着等，也不另起一张。"""

    backend = PollingBackend(polls=[httpx.Response(404, json={"detail": "Not Found"})])
    await files.write(NAMESPACE, EXTRACTION_PATH, ledger("S1-1"))

    with pytest.raises(InternalApiError, match="答 404"):
        await backend.tools(files, cuts).generate_shot_frames(
            ctx, [FrameRequest(no="S1-1", prompt="猫")], [], "全局参考", "9:16"
        )

    assert (backend.submissions, backend.queries) == (1, 1)


@pytest.mark.parametrize(
    ("cells", "message"),
    [
        ([], "1-4"),
        (["人"] * 5, "1-4"),
        (["人", "   "], "第 2 格"),
    ],
)
async def test_anchor_sheet_rejects_bad_cells_before_paying(
    tools: ShotVideoToolset[object],
    ctx: RunContext[object],
    generations: FakeGenerations,
    cells: list[str],
    message: str,
) -> None:

    with pytest.raises(ModelRetry, match=message):
        await tools.generate_anchor_sheet(ctx, cells)
    assert generations.submitted == []


async def test_anchor_sheet_submits_a_full_square_grid_without_references(
    tools: ShotVideoToolset[object],
    ctx: RunContext[object],
    generations: FakeGenerations,
) -> None:

    generations.outcomes = [
        Outcome(status="failed", output_url=None, error_code="PROVIDER_REJECTED")
    ]
    with pytest.raises(ToolFailed, match="PROVIDER_REJECTED"):
        await tools.generate_anchor_sheet(ctx, ["全身正面平视的女性", "空景全景平视的门厅"])

    request = generations.submitted[0]
    assert request.reference_image_urls == ()
    assert (request.aspect_ratio, request.resolution) == (ANCHOR_ASPECT, GRID_RESOLUTION)
    assert request.prompt.count("visual_prompt:") == 4
    assert "全身正面平视的女性" in request.prompt
    assert "空景全景平视的门厅" in request.prompt


async def test_stringified_frames_are_parsed_on_the_agent_path(
    capability: ShotVideo[object],
    files: FakeFileStore,
    generations: FakeGenerations,
) -> None:
    """frames 与 shots 同形；模型把它裹成字符串时照常受理，不退回改参数。"""

    await files.write(NAMESPACE, EXTRACTION_PATH, ledger("S1-1"))
    generations.outcomes = [
        Outcome(status="failed", output_url=None, error_code="PROVIDER_REJECTED")
    ]
    args = {
        "frames": json.dumps([{"no": "S1-1", "prompt": "猫"}], ensure_ascii=False),
        "reference_images": [],
        "global_reference": "全局参考",
        "target_aspect": "9:16",
    }

    def call_once(messages: list[ModelMessage], _info: AgentInfo) -> ModelResponse:
        if len(messages) == 1:
            return ModelResponse(
                parts=[ToolCallPart("generate_shot_frames", args, tool_call_id="c1")]
            )
        return ModelResponse(parts=[TextPart("好")])

    with capture_logs() as logs:
        result = await Agent(
            FunctionModel(call_once), capabilities=with_requirements(capability, capability.space)
        ).run("出这一批帧", deps=make_deps())

    refusals = [
        part
        for message in result.all_messages()
        for part in message.parts
        if isinstance(part, ToolReturnPart)
        and part.outcome == "retried"
        and part.tool_name == "generate_shot_frames"
    ]
    assert refusals == []
    parsed = [log for log in logs if log["event"] == "工具参数以字符串传入，已解析"]
    assert [log["field"] for log in parsed] == ["frames"]


GRID = "https://cdn.test/out.png"
"""``Outcome`` 默认交回的整图地址。"""


async def test_generate_cuts_the_requested_cells_under_their_frame_numbers(
    tools: ShotVideoToolset[object],
    ctx: RunContext[object],
    files: FakeFileStore,
    materials: FakeMaterialLedger,
    generations: FakeGenerations,
    cuts: FakeCuts,
) -> None:
    """按帧号要那几格（存到哪由宿主定），收缩到目标画幅；交回的地址与整图一起登记进素材台账。"""

    await files.write(NAMESPACE, EXTRACTION_PATH, ledger("S1-1"))

    result = await tools.generate_shot_frames(
        ctx,
        [FrameRequest(no="S1-1", prompt="雨中中景"), FrameRequest(no="S2-1", prompt="鞋底特写")],
        [],
        "全局参考",
        "9:16",
    )

    [job_id] = generations.job_ids
    assert [
        (call.user_id, call.job_id, call.grid_url, call.cells, call.aspect) for call in cuts.calls
    ] == [(USER, job_id, GRID, ShotCells(cell_ids=("S1-1", "S2-1")), "9:16")]
    urls = [cut_url(job_id, "S1-1"), cut_url(job_id, "S2-1")]
    assert result.return_value == {
        "frames": [{"no": "S1-1", "url": urls[0]}, {"no": "S2-1", "url": urls[1]}]
    }
    assert {*urls, GRID} <= materials.urls(NAMESPACE)


async def test_anchor_sheet_cuts_one_cell_per_entity_without_shrinking(
    tools: ShotVideoToolset[object],
    ctx: RunContext[object],
    generations: FakeGenerations,
    cuts: FakeCuts,
) -> None:
    result = await tools.generate_anchor_sheet(ctx, ["全身正面平视的女性", "空景全景平视的门厅"])

    [job_id] = generations.job_ids
    [call] = cuts.calls
    assert call.cells == AnchorSheets(indexes=(1, 2))
    assert call.aspect is None
    assert result.return_value == {
        "images": [{"index": index, "url": cut_url(job_id, index)} for index in (1, 2)]
    }


@pytest.mark.parametrize(
    ("tool", "message"),
    [("frames", "镜头帧处理失败。"), ("anchor", "设定图处理失败。")],
)
async def test_a_failed_cut_is_a_brief_failure_with_the_reason_in_the_log(
    tools: ShotVideoToolset[object],
    ctx: RunContext[object],
    files: FakeFileStore,
    materials: FakeMaterialLedger,
    generations: FakeGenerations,
    cuts: FakeCuts,
    tool: str,
    message: str,
) -> None:
    """切格、下载、转存失败对模型只说哪一步没成，原因只进日志；没切成的格子不登记。"""

    await files.write(NAMESPACE, EXTRACTION_PATH, ledger("S1-1"))
    cuts.error = GridCutFailed("OSS 写入失败（试了 3 次）: Read timed out")
    before = set(materials.urls(NAMESPACE))

    with capture_logs() as logs, pytest.raises(ToolFailed) as raised:
        if tool == "frames":
            await tools.generate_shot_frames(
                ctx, [FrameRequest(no="S1-1", prompt="猫")], [], "全局", "9:16"
            )
        else:
            await tools.generate_anchor_sheet(ctx, ["全身正面平视的女性"])

    assert raised.value.message == message
    assert logs[-1]["reason"] == "OSS 写入失败（试了 3 次）: Read timed out"
    assert logs[-1]["job_id"] == str(generations.job_ids[0])
    assert materials.urls(NAMESPACE) == before


async def test_a_cut_that_cannot_be_recorded_goes_up_unchanged(
    tools: ShotVideoToolset[object],
    ctx: RunContext[object],
    files: FakeFileStore,
    materials: FakeMaterialLedger,
    generations: FakeGenerations,
    cuts: FakeCuts,
) -> None:
    """切图记录落不下是数据库的事：原样抛出，不包成让模型重出一张付费宫格的重试，也不登记素材。"""

    await files.write(NAMESPACE, EXTRACTION_PATH, ledger("S1-1"))
    cuts.error = ConnectionError("数据库断了")
    before = set(materials.urls(NAMESPACE))

    with pytest.raises(ConnectionError, match="数据库断了"):
        await tools.generate_shot_frames(
            ctx, [FrameRequest(no="S1-1", prompt="猫")], [], "全局", "9:16"
        )

    assert len(generations.job_ids) == 1
    assert materials.urls(NAMESPACE) == before
