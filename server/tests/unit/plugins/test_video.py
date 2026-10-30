"""通过真实 Agent 与工具体验证视频拆解与素材范围。"""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from agent_runtime.file_store.store import FileSpace
from agent_runtime.material_ledger.store import Material
from agent_runtime.plugins.workspace.capability import Workspace
from agent_runtime.plugins.workspace.scope import workspace_namespace
from agent_runtime.run_deps import AgentRunDeps
from agent_runtime.transcript.display import GenericDisplay, ToolDisplayRegistry
from pydantic_ai import Agent
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

from iclip.plugins.video.capability import Video, VideoToolset
from iclip.plugins.video_document import video_doc_path
from iclip.plugins.video_understanding import VideoUnderstandingError
from tests.helpers.file_store import FakeFileStore
from tests.helpers.material_ledger import FakeMaterialLedger
from tests.helpers.plugins import required_tools, with_requirements
from tests.helpers.shot_video import FakeUnderstanding

USER = uuid.UUID("11111111-1111-1111-1111-111111111111")
VIDEO = "https://cdn.test/ref.mp4"
NAMESPACE = f"{USER}/thread-1"
OTHER_NAMESPACE = f"{USER}/thread-2"
DOCUMENT = "## 逐镜拉片表\n**[00:00.000-00:30.000]** 产品演示。"


@pytest.fixture
def files() -> FakeFileStore:
    return FakeFileStore()


@pytest.fixture
def materials() -> FakeMaterialLedger:
    """参考视频已在收件阶段登记。"""

    ledger = FakeMaterialLedger()
    ledger.rows[(NAMESPACE, VIDEO)] = Material(url=VIDEO, kind="video")
    return ledger


@pytest.fixture
def understanding() -> FakeUnderstanding:
    return FakeUnderstanding(document=DOCUMENT)


@pytest.fixture
def capability(
    files: FakeFileStore, materials: FakeMaterialLedger, understanding: FakeUnderstanding
) -> Video[object]:
    """与组合根同一条路：服务绑进类，再按 spec 造实例。"""

    return Video.bind(
        space=FileSpace(store=files, namespace=workspace_namespace),
        ledger=materials,
        understanding=understanding,
    ).from_spec()


@pytest.fixture
def tools(capability: Video[object]) -> VideoToolset[object]:
    return capability.get_toolset()


def make_deps() -> AgentRunDeps:
    return AgentRunDeps(user_id=USER, conversation_id="thread-1", user_name="logan")


def make_context(deps: object) -> RunContext[object]:
    return RunContext[object](deps=deps, model=TestModel(), usage=RunUsage(), messages=[])


async def invoke(
    capability: Video[object], tool_name: str, args: str | dict[str, Any]
) -> list[ModelMessage]:
    """模型只调用一次工具，随后结束，保留注册校验器与工具返回的完整路径。"""

    def script(messages: list[ModelMessage], _info: AgentInfo) -> ModelResponse:
        if len(messages) == 1:
            return ModelResponse(parts=[ToolCallPart(tool_name, args, tool_call_id="video-call")])
        return ModelResponse(parts=[TextPart("本轮结束。")])

    result = await Agent(
        FunctionModel(script), capabilities=with_requirements(capability, capability.space)
    ).run("处理参考素材。", deps=make_deps())
    return result.all_messages()


def _tool_returns(messages: list[ModelMessage]) -> list[ToolReturnPart]:
    return [
        part for message in messages for part in message.parts if isinstance(part, ToolReturnPart)
    ]


def refusals(messages: list[ModelMessage]) -> list[ToolReturnPart]:
    return [part for part in _tool_returns(messages) if part.outcome == "retried"]


def returns(messages: list[ModelMessage]) -> list[ToolReturnPart]:
    return [part for part in _tool_returns(messages) if part.outcome != "retried"]


async def test_only_video_tools_reach_the_model(capability: Video[object]) -> None:
    seen: list[str] = []

    def script(_messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        seen.extend(sorted(tool.name for tool in info.function_tools))
        return ModelResponse(parts=[TextPart("好")])

    await Agent(
        FunctionModel(script), capabilities=with_requirements(capability, capability.space)
    ).run("查看工具。", deps=make_deps())

    own = [name for name in seen if name not in required_tools(capability)]
    assert own == ["video_parser"]
    assert set(Video.display_table()) == set(own)


def test_video_requires_workspace(capability: Video[object]) -> None:
    ordering = capability.get_ordering()
    assert tuple(ordering.requires) == (Workspace,)
    assert Video.get_serialization_name() == "video"


def test_every_tool_has_a_display_without_a_renderer() -> None:
    registry = ToolDisplayRegistry.merged(Video.display_table())
    drawn = registry.entries
    parsed = drawn["video_parser"].draw({"video_url": VIDEO})
    assert isinstance(parsed, GenericDisplay)
    assert parsed.detail == "ref.mp4"
    # 缺参时仍画一张没有主语的卡，不退回 None。
    bare = drawn["video_parser"].draw({})
    assert isinstance(bare, GenericDisplay)
    assert bare.detail is None
    for tool_name in drawn:
        assert registry.view_of(tool_name) is None


async def test_parse_stores_document_in_shared_workspace(
    capability: Video[object], files: FakeFileStore, understanding: FakeUnderstanding
) -> None:
    messages = await invoke(capability, "video_parser", {"video_url": VIDEO})

    assert refusals(messages) == []
    assert understanding.calls == [VIDEO]
    stored = await files.read(NAMESPACE, video_doc_path(VIDEO))
    assert stored is not None
    assert stored.content == DOCUMENT
    delivered = returns(messages)
    assert len(delivered) == 1
    assert delivered[0].outcome == "success"
    assert video_doc_path(VIDEO) in str(delivered[0].content)
    assert await files.entries(OTHER_NAMESPACE) == []


@pytest.mark.parametrize("case", ["unregistered", "wrong-kind", "other-conversation"])
async def test_parse_rejects_invalid_material_before_understanding(
    capability: Video[object],
    files: FakeFileStore,
    materials: FakeMaterialLedger,
    understanding: FakeUnderstanding,
    case: str,
) -> None:
    url = "https://cdn.test/not-authorized.mp4"
    if case == "wrong-kind":
        materials.rows[(NAMESPACE, url)] = Material(url=url, kind="image")
    elif case == "other-conversation":
        materials.rows[(OTHER_NAMESPACE, url)] = Material(url=url, kind="video")

    messages = await invoke(capability, "video_parser", {"video_url": url})

    rejected = refusals(messages)
    assert len(rejected) == 1
    assert url not in rejected[0].model_response_str()
    assert understanding.calls == []
    assert await files.entries(NAMESPACE) == []
    assert await files.entries(OTHER_NAMESPACE) == []


@pytest.mark.parametrize("url", ["reference.mp4", "file:///etc/passwd", "ftp://host/ref.mp4"])
async def test_parse_rejects_non_http_addresses_before_understanding(
    capability: Video[object],
    files: FakeFileStore,
    understanding: FakeUnderstanding,
    url: str,
) -> None:
    messages = await invoke(capability, "video_parser", {"video_url": url})

    rejected = refusals(messages)
    assert len(rejected) == 1
    # 这些地址也没登记，台账同样会退；退回须来自 http 规则。
    assert "http" in rejected[0].model_response_str()
    assert understanding.calls == []
    assert await files.entries(NAMESPACE) == []


async def test_parse_failure_preserves_existing_document(
    capability: Video[object], files: FakeFileStore, understanding: FakeUnderstanding
) -> None:
    await files.write(NAMESPACE, video_doc_path(VIDEO), DOCUMENT)
    original = await files.read(NAMESPACE, video_doc_path(VIDEO))
    understanding.error = VideoUnderstandingError("理解服务未完成")

    messages = await invoke(capability, "video_parser", {"video_url": VIDEO})

    assert len(refusals(messages)) == 1
    assert understanding.calls == [VIDEO]
    assert await files.read(NAMESPACE, video_doc_path(VIDEO)) == original
    assert returns(messages) == []


async def test_files_land_in_the_normalized_namespace(
    files: FakeFileStore, materials: FakeMaterialLedger, understanding: FakeUnderstanding
) -> None:
    """共享 FileSpace 的能力必须使用归一化命名空间，否则工作区工具无法读取产物。"""

    toolset = Video[object](
        space=FileSpace(store=files, namespace=lambda _ctx: f"{USER}//thread-1"),
        ledger=materials,
        understanding=understanding,
    ).get_toolset()

    await toolset.video_parser(make_context(make_deps()), VIDEO)
    assert await files.read(NAMESPACE, video_doc_path(VIDEO)) is not None


async def test_missing_run_identity_is_a_bug_not_a_retry(tools: VideoToolset[object]) -> None:
    """deps 类型错误属于装配故障，模型重试无法修复。"""

    with pytest.raises(RuntimeError, match="AgentRunDeps"):
        await tools.video_parser(make_context(object()), VIDEO)


async def test_quota_failure_preserves_existing_file(
    materials: FakeMaterialLedger, understanding: FakeUnderstanding
) -> None:
    files = FakeFileStore(max_file_bytes=4096)
    capability = Video[object](
        space=FileSpace(store=files, namespace=workspace_namespace),
        ledger=materials,
        understanding=understanding,
    )
    args = {"video_url": VIDEO}
    path = video_doc_path(VIDEO)
    first = await invoke(capability, "video_parser", args)
    assert refusals(first) == []
    original = await files.read(NAMESPACE, path)
    assert original is not None
    understanding.document = DOCUMENT * 1000

    messages = await invoke(capability, "video_parser", args)

    assert len(refusals(messages)) == 1
    assert await files.read(NAMESPACE, path) == original
    assert returns(messages) == []
