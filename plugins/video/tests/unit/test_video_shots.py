"""通过真实 Agent 与工具体验证镜头组交付：素材范围、整表校验与工具卡。"""

from __future__ import annotations

import inspect
import json
import uuid
from typing import Any

import pytest
from agent_runtime.file_store.store import FileSpace
from agent_runtime.material_ledger.store import Material
from agent_runtime.plugins.workspace.capability import Workspace
from agent_runtime.plugins.workspace.scope import workspace_namespace
from agent_runtime.run_deps import AgentRunDeps
from agent_runtime.transcript.display import FileIoDisplay, ToolDisplayRegistry
from pydantic_ai import Agent, ModelRetry
from pydantic_ai.messages import (
    ModelMessage,
    ModelResponse,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
)
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.models.test import TestModel
from pydantic_ai.tools import RunContext
from pydantic_ai.usage import RunUsage
from structlog.testing import capture_logs
from structlog.typing import EventDict

from iclip_video.shot_document import (
    MAX_REFERENCE_IMAGES,
    SHOTS_PATH,
    VideoShotRequest,
    validate_shots_document,
)
from iclip_video.video_shots.capability import VideoShots, VideoShotsToolset
from tests.helpers.file_store import FakeFileStore
from tests.helpers.material_ledger import FakeMaterialLedger
from tests.helpers.plugins import required_tools, with_requirements
from tests.helpers.shot_document import FRAME_URL, OTHER_FRAME_URL, one_shot, shots_document

USER = uuid.UUID("11111111-1111-1111-1111-111111111111")
NAMESPACE = f"{USER}/thread-1"
OTHER_NAMESPACE = f"{USER}/thread-2"


@pytest.fixture
def files() -> FakeFileStore:
    return FakeFileStore()


@pytest.fixture
def materials() -> FakeMaterialLedger:
    """一张镜头帧已在收件阶段登记。"""

    ledger = FakeMaterialLedger()
    ledger.rows[(NAMESPACE, FRAME_URL)] = Material(url=FRAME_URL, kind="image")
    return ledger


@pytest.fixture
def plugin(files: FakeFileStore, materials: FakeMaterialLedger) -> type[VideoShots[object]]:
    """与组合根同一条路：服务绑进类。"""

    return VideoShots[object].bind(
        space=FileSpace(store=files, namespace=workspace_namespace), ledger=materials
    )


@pytest.fixture
def capability(plugin: type[VideoShots[object]]) -> VideoShots[object]:
    return plugin.from_spec()


@pytest.fixture
def tools(capability: VideoShots[object]) -> VideoShotsToolset[object]:
    return capability.get_toolset()


@pytest.fixture
def ctx() -> RunContext[object]:
    return RunContext[object](deps=make_deps(), model=TestModel(), usage=RunUsage(), messages=[])


def make_deps() -> AgentRunDeps:
    return AgentRunDeps(user_id=USER, conversation_id="thread-1", user_name="logan")


def shot_payload(image_urls: list[str]) -> dict[str, Any]:
    """agent 路径提交的一组镜头；全局设定按顺序引用每张图。"""

    references = "、".join(f"@Image{index}" for index in range(1, len(image_urls) + 1))
    return {
        "aspect_ratio": "9:16",
        "shots": [
            {
                "index": 1,
                "prompt": {
                    "global_settings": f"产品外观使用参考图片 {references}。",
                    "timeline": [
                        {"timestamps": [0, 15], "prompt": "中景，人物拿起产品。"},
                        {"timestamps": [15, 30], "prompt": "特写，展示产品细节。"},
                    ],
                },
                "seconds": 30,
                "image_urls": image_urls,
            }
        ],
    }


async def invoke(
    capability: VideoShots[object], tool_name: str, args: str | dict[str, Any]
) -> list[ModelMessage]:
    """模型只调用一次工具，随后结束，保留注册校验器与工具返回的完整路径。"""

    def script(messages: list[ModelMessage], _info: AgentInfo) -> ModelResponse:
        if len(messages) == 1:
            return ModelResponse(parts=[ToolCallPart(tool_name, args, tool_call_id="shots-call")])
        return ModelResponse(parts=[TextPart("本轮结束。")])

    result = await Agent(
        FunctionModel(script), capabilities=with_requirements(capability, capability.space)
    ).run("提交镜头组。", deps=make_deps())
    return result.all_messages()


def _tool_returns(messages: list[ModelMessage]) -> list[ToolReturnPart]:
    return [
        part for message in messages for part in message.parts if isinstance(part, ToolReturnPart)
    ]


def refusals(messages: list[ModelMessage]) -> list[ToolReturnPart]:
    return [part for part in _tool_returns(messages) if part.outcome == "retried"]


def returns(messages: list[ModelMessage]) -> list[ToolReturnPart]:
    return [part for part in _tool_returns(messages) if part.outcome != "retried"]


async def check_args(
    tools: VideoShotsToolset[object], name: str, ctx: RunContext[object], **args: Any
) -> None:
    """通过工具注册表调用校验器，覆盖 args_validator 的挂载遗漏。"""

    validator = tools.tools[name].args_validator
    assert validator is not None, f"{name} 登记时没挂验证器"
    outcome = validator(ctx, **args)
    assert inspect.isawaitable(outcome), "本包的验证器都是 async 的"
    await outcome


async def deliver(
    tools: VideoShotsToolset[object],
    ctx: RunContext[object],
    shots: list[VideoShotRequest],
    *,
    aspect_ratio: str = "9:16",
) -> str:
    """直接调用交付工具体，取给模型的那份；地址范围校验由独立用例覆盖。"""

    delivered = await tools.write_video_shots(ctx, aspect_ratio, shots)
    assert isinstance(delivered.return_value, str)
    return delivered.return_value


async def test_only_the_delivery_tool_reaches_the_model(
    capability: VideoShots[object], plugin: type[VideoShots[object]]
) -> None:
    seen: list[str] = []

    def script(_messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        seen.extend(sorted(tool.name for tool in info.function_tools))
        return ModelResponse(parts=[TextPart("好")])

    await Agent(
        FunctionModel(script), capabilities=with_requirements(capability, capability.space)
    ).run("查看工具。", deps=make_deps())

    own = [name for name in seen if name not in required_tools(capability)]
    assert own == ["write_video_shots"]
    assert set(plugin.display_table()) == set(own)


def test_video_shots_requires_workspace(
    plugin: type[VideoShots[object]], capability: VideoShots[object]
) -> None:
    assert plugin.get_serialization_name() == "video_shots"
    assert tuple(capability.get_ordering().requires) == (Workspace,)


async def test_structured_shot_input_schema_reaches_the_model(
    capability: VideoShots[object],
) -> None:
    seen: dict[str, Any] = {}

    def script(_messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        tool = next(tool for tool in info.function_tools if tool.name == "write_video_shots")
        seen["schema"] = tool.parameters_json_schema
        return ModelResponse(parts=[TextPart("好")])

    await Agent(
        FunctionModel(script), capabilities=with_requirements(capability, capability.space)
    ).run("看看参数", deps=make_deps())

    schema = seen["schema"]
    assert set(schema["properties"]) == {"aspect_ratio", "shots"}
    assert set(schema["required"]) == {"aspect_ratio", "shots"}
    definitions = schema["$defs"]
    shot = definitions["VideoShotRequest"]
    assert set(shot["properties"]) == {"index", "prompt", "seconds", "image_urls"}
    assert set(shot["required"]) == set(shot["properties"])
    assert shot["properties"]["prompt"] == {"$ref": "#/$defs/VideoShotPrompt"}
    assert shot["properties"]["image_urls"]["type"] == "array"
    assert shot["properties"]["image_urls"].get("minItems", 0) == 0
    assert shot["properties"]["image_urls"]["maxItems"] == MAX_REFERENCE_IMAGES
    prompt = definitions["VideoShotPrompt"]
    assert prompt["type"] == "object"
    assert set(prompt["properties"]) == {"global_settings", "timeline"}
    assert set(prompt["required"]) == set(prompt["properties"])
    assert prompt["additionalProperties"] is False
    assert prompt["properties"]["timeline"]["minItems"] == 1
    timeline_item = definitions["TimelineItem"]
    assert set(timeline_item["properties"]) == {"timestamps", "prompt"}
    assert set(timeline_item["required"]) == set(timeline_item["properties"])
    assert timeline_item["additionalProperties"] is False
    timestamps = timeline_item["properties"]["timestamps"]
    assert timestamps["type"] == "array"
    assert timestamps["minItems"] == timestamps["maxItems"] == 2
    assert timestamps["items"]["type"] == "number"
    assert timestamps["items"]["minimum"] == 0


def test_the_delivery_has_a_display_without_a_renderer(plugin: type[VideoShots[object]]) -> None:
    registry = ToolDisplayRegistry.merged(plugin.display_table())
    shots = registry.entries["write_video_shots"].draw({})
    assert shots == FileIoDisplay(operation="write", path=SHOTS_PATH)
    assert registry.view_of("write_video_shots") is None


@pytest.mark.parametrize("stringified", [None, "shots", "prompt"])
async def test_shots_card_shows_exactly_what_the_delivery_writes(
    capability: VideoShots[object],
    plugin: type[VideoShots[object]],
    files: FakeFileStore,
    stringified: str | None,
) -> None:
    """分镜表的交付画成普通文件写入，卡上的原文就是工具写进文件的那份；字符串化入参照常还原且只记一条日志。"""

    shot = one_shot().model_dump()
    shots: object = [shot]
    if stringified == "prompt":
        shot["prompt"] = json.dumps(shot["prompt"], ensure_ascii=False)
    elif stringified == "shots":
        shots = json.dumps([shot], ensure_ascii=False)
    args = {"aspect_ratio": "9:16", "shots": shots}

    with capture_logs() as logs:
        drawn = plugin.display_table()["write_video_shots"](args)
    rejected, _ = await run_delivery_once(capability, shots)

    assert rejected == []
    stored = await files.read(NAMESPACE, SHOTS_PATH)
    assert stored is not None
    assert drawn == FileIoDisplay(operation="write", path=SHOTS_PATH, content=stored.content)
    assert logs == [], "画卡是重放入参，字符串还原的日志只由工具调用记"


async def test_shots_card_from_json_text_args_matches_the_written_file(
    capability: VideoShots[object], plugin: type[VideoShots[object]], files: FakeFileStore
) -> None:
    """模型多以 JSON 文本给参数：投影经注册表画卡，与工具按 JSON 校验后写下的原文一致。"""

    args = json.dumps(shot_payload([FRAME_URL]), ensure_ascii=False)

    messages = await invoke(capability, "write_video_shots", args)

    assert refusals(messages) == []
    stored = await files.read(NAMESPACE, SHOTS_PATH)
    assert stored is not None
    drawn = ToolDisplayRegistry.merged(plugin.display_table()).tool_display(
        "write_video_shots", args
    )
    assert drawn == FileIoDisplay(operation="write", path=SHOTS_PATH, content=stored.content)


@pytest.mark.parametrize(
    "args",
    [
        {"aspect_ratio": "9:16", "shots": [one_shot(index=2).model_dump()]},
        {"aspect_ratio": "竖版", "shots": [one_shot().model_dump()]},
        {"aspect_ratio": "9:16", "shots": "index: 1"},
        {"shots": [one_shot().model_dump()]},
        "不是对象",
    ],
    ids=["bad-index", "bad-aspect", "not-json", "no-aspect", "not-a-mapping"],
)
def test_shots_card_without_content_when_the_delivery_would_be_refused(
    plugin: type[VideoShots[object]], args: object
) -> None:
    """工具会退回的入参没有要写的原文：照样是写入 video_shot.json 那一行，只是不带内容。"""

    drawn = plugin.display_table()["write_video_shots"](args)

    assert drawn == FileIoDisplay(operation="write", path=SHOTS_PATH)


async def test_delivered_table_lands_in_the_workspace(
    tools: VideoShotsToolset[object], ctx: RunContext[object], files: FakeFileStore
) -> None:
    shots = [one_shot(), one_shot(index=2, seconds=12, image_urls=[FRAME_URL, OTHER_FRAME_URL])]
    result = await deliver(tools, ctx, shots)

    assert SHOTS_PATH in result
    assert "20 秒" in result
    stored = await files.read(NAMESPACE, SHOTS_PATH)
    assert stored is not None
    document = json.loads(stored.content)
    expected_rows = [shot.model_dump(mode="json") for shot in shots]
    for row in expected_rows:
        row["prompt"]["timeline"][0]["image_indexes"] = [1]
    assert document == {"aspect_ratio": "9:16", "shots": expected_rows}
    validate_shots_document(stored.content)


async def test_delivered_table_accepts_a_group_without_reference_images(
    tools: VideoShotsToolset[object], ctx: RunContext[object], files: FakeFileStore
) -> None:
    shot = one_shot(
        prompt={
            "global_settings": "人物与门厅保持一致。",
            "timeline": [{"timestamps": [0, 8], "prompt": " 她走进门厅。\n"}],
        },
        image_urls=[],
    )
    await check_args(tools, "write_video_shots", ctx, aspect_ratio="9:16", shots=[shot])

    result = await deliver(tools, ctx, [shot])

    assert SHOTS_PATH in result
    stored = await files.read(NAMESPACE, SHOTS_PATH)
    assert stored is not None
    expected = shot.model_dump(mode="json")
    expected["prompt"]["timeline"][0]["image_indexes"] = []
    assert json.loads(stored.content) == {"aspect_ratio": "9:16", "shots": [expected]}
    validate_shots_document(stored.content)


@pytest.mark.parametrize(
    ("shots", "message"),
    [
        ([], "一条都没有"),
        ([one_shot(index=2)], "连续编号"),
        (
            [
                one_shot(
                    prompt={
                        "global_settings": "人物与门厅保持一致。",
                        "timeline": [{"timestamps": [0, 8], "prompt": "   "}],
                    }
                )
            ],
            "prompt 为空",
        ),
        ([one_shot(seconds=3)], "4-30"),
        ([one_shot(seconds=31)], "4-30"),
        ([one_shot(image_urls=[])], "@Image1"),
        (
            [
                one_shot(
                    prompt={
                        "global_settings": "人物与门厅保持一致。",
                        "timeline": [{"timestamps": [0, 8], "prompt": "她走进门厅 @Image2。"}],
                    }
                )
            ],
            "@Image2",
        ),
    ],
)
async def test_delivery_rejects_the_whole_table(
    tools: VideoShotsToolset[object],
    ctx: RunContext[object],
    files: FakeFileStore,
    shots: list[VideoShotRequest],
    message: str,
) -> None:
    with pytest.raises(ModelRetry, match=message):
        await deliver(tools, ctx, shots)
    assert await files.read(NAMESPACE, SHOTS_PATH) is None


async def test_invalid_later_group_preserves_the_complete_existing_file(
    tools: VideoShotsToolset[object], ctx: RunContext[object], files: FakeFileStore
) -> None:
    original = shots_document()
    written = await files.write(NAMESPACE, SHOTS_PATH, original)
    shots = [one_shot(seconds=12), one_shot(index=2, image_urls=[])]

    with pytest.raises(ModelRetry, match=r"镜头组 2.*@Image1"):
        await deliver(tools, ctx, shots)

    stored = await files.read(NAMESPACE, SHOTS_PATH)
    assert stored is not None
    assert (stored.content, stored.version) == (original, written.version)


async def test_delivery_rejects_a_bad_aspect_ratio(
    tools: VideoShotsToolset[object], ctx: RunContext[object], files: FakeFileStore
) -> None:
    with pytest.raises(ModelRetry, match="画幅"):
        await deliver(tools, ctx, [one_shot()], aspect_ratio="竖版")
    assert await files.read(NAMESPACE, SHOTS_PATH) is None


async def test_delivery_rejects_a_made_up_frame_url(
    tools: VideoShotsToolset[object], ctx: RunContext[object]
) -> None:
    """拒绝未登记帧地址，错误仅提示合法来源，不回显该地址。"""

    with pytest.raises(ModelRetry, match="不要自己拼。") as rejected:
        await check_args(
            tools,
            "write_video_shots",
            ctx,
            aspect_ratio="9:16",
            shots=[one_shot(image_urls=["https://cdn.test/编的.jpg"])],
        )
    assert "编的" not in str(rejected.value), "被拒的地址不回显，否则重试一次就洗成素材了"


async def test_delivery_rejects_a_frame_url_that_is_not_http(
    tools: VideoShotsToolset[object], ctx: RunContext[object]
) -> None:
    with pytest.raises(ModelRetry, match="http"):
        await check_args(
            tools,
            "write_video_shots",
            ctx,
            aspect_ratio="9:16",
            shots=[one_shot(image_urls=["frames/s1-1.jpg"])],
        )


@pytest.mark.parametrize("case", ["unregistered", "wrong-kind", "other-conversation"])
async def test_delivery_rejects_invalid_reference_material_without_writing(
    capability: VideoShots[object],
    files: FakeFileStore,
    materials: FakeMaterialLedger,
    case: str,
) -> None:
    url = "https://cdn.test/not-authorized.jpg"
    if case == "wrong-kind":
        materials.rows[(NAMESPACE, url)] = Material(url=url, kind="video")
    elif case == "other-conversation":
        materials.rows[(OTHER_NAMESPACE, url)] = Material(url=url, kind="image")

    messages = await invoke(capability, "write_video_shots", shot_payload([url]))

    rejected = refusals(messages)
    assert len(rejected) == 1
    assert url not in rejected[0].model_response_str()
    assert await files.entries(NAMESPACE) == []
    assert await files.entries(OTHER_NAMESPACE) == []


@pytest.mark.parametrize("count", [0, 1, MAX_REFERENCE_IMAGES])
async def test_delivery_accepts_reference_count_boundaries(
    capability: VideoShots[object],
    files: FakeFileStore,
    materials: FakeMaterialLedger,
    count: int,
) -> None:
    urls = [f"https://cdn.test/user-{index}.jpg" for index in range(count)]
    await materials.record(NAMESPACE, [Material(url=url, kind="image") for url in urls])

    messages = await invoke(capability, "write_video_shots", shot_payload(urls))

    assert refusals(messages) == []
    stored = await files.read(NAMESPACE, SHOTS_PATH)
    assert stored is not None
    assert json.loads(stored.content)["shots"][0]["image_urls"] == urls


async def test_delivery_rejects_more_references_than_the_cap(
    capability: VideoShots[object], files: FakeFileStore, materials: FakeMaterialLedger
) -> None:
    urls = [f"https://cdn.test/user-{index}.jpg" for index in range(MAX_REFERENCE_IMAGES + 1)]
    await materials.record(NAMESPACE, [Material(url=url, kind="image") for url in urls])

    messages = await invoke(capability, "write_video_shots", shot_payload(urls))

    assert len(refusals(messages)) == 1
    assert await files.read(NAMESPACE, SHOTS_PATH) is None


@pytest.mark.parametrize(
    "prompt",
    [
        "0-8s 她走进门厅 @Image1。",
        {
            "global_settings": "人物与门厅保持一致。",
            "timeline": [
                {"timestamps": [0, 5], "prompt": "她走进门厅 @Image1。"},
                {"timestamps": [4, 8], "prompt": "她停下脚步 @Image1。"},
            ],
        },
    ],
    ids=["string-prompt", "overlapping-timeline"],
)
async def test_invalid_shot_input_keeps_the_existing_file_on_the_agent_path(
    capability: VideoShots[object], files: FakeFileStore, prompt: object
) -> None:
    original = shots_document()
    await files.write(NAMESPACE, SHOTS_PATH, original)
    shot = one_shot().model_dump()
    shot["prompt"] = prompt

    refusals_seen, _ = await run_delivery_once(capability, [shot])

    assert len(refusals_seen) == 1
    stored = await files.read(NAMESPACE, SHOTS_PATH)
    assert stored is not None
    assert stored.content == original


async def run_delivery_once(
    capability: VideoShots[object], shots: object
) -> tuple[list[ToolReturnPart], list[EventDict]]:
    """让模型只调一次交付工具，返回它收到的退回单与本次的日志。"""

    def call_once(messages: list[ModelMessage], _info: AgentInfo) -> ModelResponse:
        if len(messages) == 1:
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        "write_video_shots",
                        {"aspect_ratio": "9:16", "shots": shots},
                        tool_call_id="c1",
                    )
                ]
            )
        return ModelResponse(parts=[TextPart("好")])

    with capture_logs() as logs:
        result = await Agent(
            FunctionModel(call_once), capabilities=with_requirements(capability, capability.space)
        ).run("提交镜头组", deps=make_deps())
    rejected = [
        part for part in refusals(result.all_messages()) if part.tool_name == "write_video_shots"
    ]
    return rejected, logs


@pytest.mark.parametrize("field", ["shots", "prompt"])
async def test_stringified_nested_input_is_parsed_on_the_agent_path(
    capability: VideoShots[object], files: FakeFileStore, field: str
) -> None:
    """弱模型把嵌套结构整体序列化成字符串时照常交付，并留一条可数的日志。"""

    shot = one_shot().model_dump()
    shots: object
    if field == "prompt":
        shot["prompt"] = json.dumps(shot["prompt"], ensure_ascii=False)
        shots = [shot]
    else:
        shots = json.dumps([shot], ensure_ascii=False)

    rejected, logs = await run_delivery_once(capability, shots)

    assert rejected == []
    stored = await files.read(NAMESPACE, SHOTS_PATH)
    assert stored is not None
    validate_shots_document(stored.content)
    parsed = [log for log in logs if log["event"] == "工具参数以字符串传入，已解析"]
    assert [log["field"] for log in parsed] == [field]


async def test_a_string_that_is_not_json_is_refused_and_keeps_the_file(
    capability: VideoShots[object], files: FakeFileStore
) -> None:
    original = shots_document()
    await files.write(NAMESPACE, SHOTS_PATH, original)

    rejected, _ = await run_delivery_once(capability, "index: 1, seconds: 8")

    assert len(rejected) == 1
    stored = await files.read(NAMESPACE, SHOTS_PATH)
    assert stored is not None
    assert stored.content == original


async def test_quota_failure_preserves_existing_file(materials: FakeMaterialLedger) -> None:
    files = FakeFileStore(max_file_bytes=4096)
    capability = VideoShots[object](
        space=FileSpace(store=files, namespace=workspace_namespace), ledger=materials
    )
    args = shot_payload([FRAME_URL])
    first = await invoke(capability, "write_video_shots", args)
    assert refusals(first) == []
    original = await files.read(NAMESPACE, SHOTS_PATH)
    assert original is not None
    args["shots"][0]["prompt"]["global_settings"] += "产品特征。" * 1000

    messages = await invoke(capability, "write_video_shots", args)

    assert len(refusals(messages)) == 1
    assert await files.read(NAMESPACE, SHOTS_PATH) == original
    assert returns(messages) == []
