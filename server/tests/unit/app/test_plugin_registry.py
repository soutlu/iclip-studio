"""插件登记表：按配置登记哪些插件、每个插件按 spec 造出的实例与它的依赖、各适配器。"""

from __future__ import annotations

import json
import uuid
from collections.abc import Sequence
from typing import Any, cast

import httpx
import pytest
from agent_runtime.assembly.displays import build_display_registry
from agent_runtime.errors import NotFound, ValidationFailed
from agent_runtime.harness.background import BackgroundTools
from agent_runtime.plugins.base import PluginRegistry
from agent_runtime.plugins.workspace.capability import Workspace
from agent_runtime.run_deps import AgentRunDeps
from iclip_video.iclip_studio.capability import IclipStudio
from iclip_video.shot_video.capability import ShotVideo
from iclip_video.shot_video.generation import IMAGE_MODEL
from iclip_video.shot_video.ports import ImageRequest, InvalidImageRequest
from iclip_video.video.capability import Video
from iclip_video.video_breakdown.capability import VideoBreakdown, VideoBreakdownPlugin
from iclip_video.video_shots.capability import VideoShots
from pydantic_ai import Agent, AgentSpec
from pydantic_ai.capabilities import AbstractCapability, Capability
from pydantic_ai.exceptions import UserError
from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.models.test import TestModel

from iclip.app.plugin_registry import GenerationsAdapter, build_plugin_registry
from iclip.app.reference_breakdown import ReferenceBreakdownsAdapter
from iclip.config import ResolvedIclipStudio, ResolvedShotVideo, ResolvedVideo
from iclip.domains.generation.models import GenerationJob
from iclip.domains.generation.schemas import ImageGenerationIn
from iclip.domains.generation.service import GenerationService, SettledRecords
from iclip.domains.identity.public import Principal
from iclip.domains.references.models import Outcome
from iclip.domains.references.service import ReferenceService
from iclip.platform.media.codec import SOFTWARE
from tests.helpers.fetch_url import as_is
from tests.helpers.file_store import FakeFileStore
from tests.helpers.generation import MemoryObjectStore, make_job
from tests.helpers.identity import FakePrincipals
from tests.helpers.material_ledger import FakeMaterialLedger
from tests.helpers.plugins import FixedPlugin


def idle_client() -> httpx.AsyncClient:
    """装配测试不发送网络请求。"""

    return httpx.AsyncClient()


@pytest.fixture
def video_settings() -> ResolvedVideo:
    return ResolvedVideo(
        understanding_url="https://vision.test/responses",
        understanding_api_key="ark",
        understanding_model="seed-vision",
        understanding_thinking="medium",
        understanding_fps=5,
    )


@pytest.fixture
def shot_video_settings() -> ResolvedShotVideo:
    return ResolvedShotVideo(
        poll_interval_seconds=5.0,
        dev_attempts=2,
        pro_attempts=1,
        backoff_seconds=5.0,
        backoff_factor=3.0,
        job_timeout_seconds=1800.0,
    )


@pytest.fixture
def dummy() -> Capability[object]:
    return Capability[object](id="dummy", instructions="按镜头表干活。")


@pytest.fixture
def registry(dummy: Capability[object]) -> PluginRegistry:
    return {"dummy": FixedPlugin.bind(name="dummy", capabilities=(dummy,))}


def assert_kinds(capabilities: Sequence[object], expected: Sequence[type]) -> None:
    """逐项是这些插件类的实例；登记表里的类是绑了服务的子类，所以按 isinstance 比。"""

    assert len(capabilities) == len(expected)
    for capability, kind in zip(capabilities, expected, strict=True):
        assert isinstance(capability, kind), f"{type(capability).__name__} 不是 {kind.__name__}"


def mount(names: Sequence[str], registry: PluginRegistry) -> tuple[AbstractCapability[Any], ...]:
    """按名字各用 ``from_spec`` 造一份，与 ``Agent.from_spec`` 按 spec 造实例走同一个入口。"""

    return tuple(registry[name].from_spec() for name in names)


def test_registered_name_resolves(dummy: Capability[object], registry: PluginRegistry) -> None:
    assert mount(("dummy",), registry) == (dummy,)


def test_shot_video_is_not_registered_unless_the_composition_root_passes_it() -> None:

    built = build_plugin_registry(
        workspace_store=FakeFileStore(),
        material_ledger=FakeMaterialLedger(),
        http_client=idle_client(),
        fetch_url=as_is,
        resolve_principal=FakePrincipals(),
    )
    assert set(built) == {"workspace", "iclip_studio", "video_shots"}


def test_plugins_without_their_own_config_are_always_registered() -> None:
    """工程文件检查与镜头组交付只用工作区和素材台账：什么都没配也登记，挂时要一起挂 workspace。"""

    built = build_plugin_registry(
        workspace_store=FakeFileStore(),
        material_ledger=FakeMaterialLedger(),
        http_client=idle_client(),
        fetch_url=as_is,
        resolve_principal=FakePrincipals(),
    )

    resolved = mount(("workspace", "iclip_studio", "video_shots"), built)
    assert_kinds(resolved, [Workspace, IclipStudio, VideoShots])
    shots = resolved[2]
    assert isinstance(shots, VideoShots)
    assert set(shots.get_toolset().tools) == {"write_video_shots"}
    assert built["video_shots"].required_plugins() == ("workspace",)


STUDIO = ResolvedIclipStudio(
    breakdown_url="https://vision.test/responses",
    breakdown_api_key="ark",
    breakdown_model="seed-vision",
    breakdown_concurrency=2,
)
STUDIO_VIDEO = "https://cdn.test/ref.mp4"
STUDIO_PRINCIPAL = Principal(
    kind="user",
    user_id=uuid.UUID("11111111-1111-1111-1111-111111111111"),
    permissions=frozenset({"agent:run"}),
    audit_label="logan",
)


class RecordingReferences:
    """参考视频服务的替身：记下工具要了哪条视频，交回一份拆解。"""

    def __init__(self) -> None:
        self.asked: list[tuple[Principal, str]] = []

    async def ensure(self, principal: Principal, video_url: str) -> Outcome:
        self.asked.append((principal, video_url))
        return Outcome(document="# 出场元素")


async def test_video_breakdown_breaks_videos_down_through_the_reference_service() -> None:
    """不需要对象存储：拆解在参考视频那一行上，与资料库共用。"""

    references = RecordingReferences()
    built = build_plugin_registry(
        workspace_store=FakeFileStore(),
        material_ledger=FakeMaterialLedger(),
        http_client=idle_client(),
        fetch_url=as_is,
        resolve_principal=FakePrincipals(STUDIO_PRINCIPAL),
        iclip_studio=STUDIO,
        reference_service=cast("ReferenceService", references),
    )

    workspace, plugin, studio = mount(("workspace", "video_breakdown", "iclip_studio"), built)
    assert isinstance(workspace, Workspace)
    assert isinstance(plugin, VideoBreakdownPlugin)
    capability, background = plugin.capabilities
    assert isinstance(capability, VideoBreakdown)
    assert isinstance(background, BackgroundTools), "breakdown_video 要挂着后台工具才在后台跑"
    assert isinstance(studio, IclipStudio), "后台工具只跟着 video_breakdown 挂"
    assert isinstance(capability.breakdowns, ReferenceBreakdownsAdapter)
    owner = STUDIO_PRINCIPAL.user_id
    assert await capability.breakdowns.ensure(owner, STUDIO_VIDEO) == "# 出场元素"
    assert references.asked == [(STUDIO_PRINCIPAL, STUDIO_VIDEO)]
    assert built["video_breakdown"].required_plugins() == ("workspace",)


def test_video_breakdown_without_the_reference_service_is_an_assembly_error() -> None:
    with pytest.raises(RuntimeError, match="video_breakdown 要有参考视频服务"):
        build_plugin_registry(
            workspace_store=FakeFileStore(),
            material_ledger=FakeMaterialLedger(),
            http_client=idle_client(),
            fetch_url=as_is,
            resolve_principal=FakePrincipals(),
            object_store=MemoryObjectStore(),
            iclip_studio=STUDIO,
        )


def test_shot_video_passed_without_its_backing_is_an_assembly_error(
    shot_video_settings: ResolvedShotVideo,
) -> None:
    """是否启用由 ResolvedSettings.shot_tools_enabled 判；传进来却缺生成或对象存储是组合根的错。"""

    with pytest.raises(RuntimeError, match="shot_tools_enabled"):
        build_plugin_registry(
            workspace_store=FakeFileStore(),
            material_ledger=FakeMaterialLedger(),
            http_client=idle_client(),
            fetch_url=as_is,
            resolve_principal=FakePrincipals(),
            shot_video=shot_video_settings,
        )


def test_shot_video_is_registered_when_backed(
    video_settings: ResolvedVideo, shot_video_settings: ResolvedShotVideo
) -> None:
    built = build_plugin_registry(
        workspace_store=FakeFileStore(),
        material_ledger=FakeMaterialLedger(),
        generation_service=cast("GenerationService", object()),
        settled_records=cast("SettledRecords", object()),
        object_store=MemoryObjectStore(),
        http_client=idle_client(),
        fetch_url=as_is,
        resolve_principal=FakePrincipals(),
        video=video_settings,
        shot_video=shot_video_settings,
        image_models=frozenset({IMAGE_MODEL}),
        media_codec=SOFTWARE,
    )
    resolved = mount(("workspace", "video", "shot_video"), built)
    assert_kinds(resolved, [Workspace, Video, ShotVideo])


def test_shot_video_requires_workspace_and_video(
    video_settings: ResolvedVideo, shot_video_settings: ResolvedShotVideo
) -> None:
    """取帧读 video 写的拆解文档、产物靠工作区工具读取：两者都写在插件的依赖里，发布与运行前的编译按它
    拦，pydantic-ai 装配时也查（见最后一个用例）。"""

    built = build_plugin_registry(
        workspace_store=FakeFileStore(),
        material_ledger=FakeMaterialLedger(),
        generation_service=cast("GenerationService", object()),
        settled_records=cast("SettledRecords", object()),
        object_store=MemoryObjectStore(),
        http_client=idle_client(),
        fetch_url=as_is,
        resolve_principal=FakePrincipals(),
        video=video_settings,
        shot_video=shot_video_settings,
        image_models=frozenset({IMAGE_MODEL}),
        media_codec=SOFTWARE,
    )
    assert set(built["shot_video"].required_plugins()) == {"workspace", "video"}


def test_the_display_registry_merges_every_display_source(
    video_settings: ResolvedVideo, shot_video_settings: ResolvedShotVideo
) -> None:
    """合并 display 表时需包含不在插件登记表中的 skill 和子代理工具。"""

    built = build_plugin_registry(
        workspace_store=FakeFileStore(),
        material_ledger=FakeMaterialLedger(),
        generation_service=cast("GenerationService", object()),
        settled_records=cast("SettledRecords", object()),
        object_store=MemoryObjectStore(),
        http_client=idle_client(),
        fetch_url=as_is,
        resolve_principal=FakePrincipals(),
        video=video_settings,
        shot_video=shot_video_settings,
        image_models=frozenset({IMAGE_MODEL}),
        media_codec=SOFTWARE,
    )

    registry = build_display_registry(built)

    # 每个来源各挑一件：workspace、video、video_shots、iclip_studio、shot_video、skill、派活；
    # 来源内的清单归各自的测试。
    assert {
        "read_file",
        "video_parser",
        "write_video_shots",
        "check_film",
        "generate_shot_frames",
        "load_capability",
        "delegate_task",
    } <= set(registry.entries)


def test_a_plugin_with_an_empty_table_adds_nothing(registry: PluginRegistry) -> None:

    displays = build_display_registry(registry)

    assert set(displays.entries) == set(build_display_registry({}).entries)


async def test_generations_adapter_translates_and_reports_bad_parameters() -> None:
    """生成域定义请求约束，适配器负责映射参数与错误。"""

    adapter = GenerationsAdapter(
        cast("GenerationService", object()), FakePrincipals(STUDIO_PRINCIPAL)
    )
    with pytest.raises(InvalidImageRequest, match="aspect_ratio"):
        await adapter.submit(
            STUDIO_PRINCIPAL.user_id,
            ImageRequest(
                prompt="猫",
                model="nano_banana_pro",
                aspect_ratio="17:9",
                resolution="1k",
                channel="dev",
                user_name="logan",
            ),
        )


async def test_generations_adapter_carries_the_conversation_onto_the_job() -> None:

    seen: list[ImageGenerationIn] = []

    class _Recording:
        async def submit_image(
            self, principal: Principal, request: ImageGenerationIn
        ) -> GenerationJob:
            _ = principal
            seen.append(request)
            return make_job(request)

    conversation_id = uuid.uuid4()
    adapter = GenerationsAdapter(
        cast("GenerationService", _Recording()), FakePrincipals(STUDIO_PRINCIPAL)
    )
    await adapter.submit(
        STUDIO_PRINCIPAL.user_id,
        ImageRequest(
            prompt="猫",
            model="nano_banana_pro",
            aspect_ratio="1:1",
            resolution="1k",
            channel="dev",
            user_name="designer-zhang",
            conversation_id=str(conversation_id),
        ),
    )
    assert seen[0].conversation_id == conversation_id
    assert seen[0].user_name == "designer-zhang", "运行替谁跑，图就记在谁头上"


async def test_generations_adapter_turns_intake_rejection_into_a_fixable_error() -> None:
    """受理层按所选模型的能力拒绝时，工具要能让模型改参数，而不是把异常裸抛出去。"""

    class _Rejecting:
        async def submit_image(
            self, principal: Principal, request: ImageGenerationIn
        ) -> GenerationJob:
            _ = principal, request
            raise ValidationFailed("nano_banana_pro 不支持分辨率 8k")

    adapter = GenerationsAdapter(
        cast("GenerationService", _Rejecting()), FakePrincipals(STUDIO_PRINCIPAL)
    )
    with pytest.raises(InvalidImageRequest, match="不支持分辨率 8k"):
        await adapter.submit(
            STUDIO_PRINCIPAL.user_id,
            ImageRequest(
                prompt="猫",
                model="nano_banana_pro",
                aspect_ratio="1:1",
                resolution="1k",
                channel="dev",
                user_name="logan",
            ),
        )


CAT = ImageRequest(
    prompt="猫",
    model="nano_banana_pro",
    aspect_ratio="1:1",
    resolution="1k",
    channel="dev",
    user_name="logan",
)


class _RecordingGenerations:
    """生成域的替身：记下每次收到的主体，查询按受理时的那一行答。"""

    def __init__(self) -> None:
        self.principals: list[Principal] = []
        self._jobs: dict[uuid.UUID, GenerationJob] = {}

    async def submit_image(self, principal: Principal, request: ImageGenerationIn) -> GenerationJob:
        self.principals.append(principal)
        job = make_job(request)
        self._jobs[job.id] = job
        return job

    async def get(self, principal: Principal, job_id: uuid.UUID) -> GenerationJob:
        self.principals.append(principal)
        return self._jobs[job_id]


def recording_generations(
    principals: FakePrincipals,
) -> tuple[GenerationsAdapter, _RecordingGenerations]:
    service = _RecordingGenerations()
    adapter = GenerationsAdapter(cast("GenerationService", service), principals)
    return adapter, service


async def test_generations_adapter_rebuilds_the_owner_principal_on_every_call() -> None:
    """端口只收属主 id：每次调用都按它重建一次主体，生成域收到的就是重建出的那一个。"""

    principals = FakePrincipals(STUDIO_PRINCIPAL)
    adapter, service = recording_generations(principals)
    owner = STUDIO_PRINCIPAL.user_id

    job = await adapter.submit(owner, CAT)
    await adapter.get(owner, job.job_id)

    assert principals.asked == [owner, owner]
    assert service.principals == [STUDIO_PRINCIPAL] * 2


async def test_generations_adapter_lets_a_resolver_failure_through() -> None:
    """属主账号不在了：重建主体的错误原样抛出，生成域一次都不调。"""

    adapter, service = recording_generations(FakePrincipals())
    owner = STUDIO_PRINCIPAL.user_id

    with pytest.raises(NotFound, match="用户不存在"):
        await adapter.submit(owner, CAT)
    with pytest.raises(NotFound, match="用户不存在"):
        await adapter.get(owner, uuid.uuid4())
    assert service.principals == []


def test_shot_video_refuses_to_mount_when_its_image_model_is_not_wired(
    shot_video_settings: ResolvedShotVideo,
) -> None:
    """出图把用哪家钉在代码里；配置没接这家，起不来比跑起来之后每次出图失败好。"""

    with pytest.raises(RuntimeError, match=IMAGE_MODEL):
        build_plugin_registry(
            workspace_store=FakeFileStore(),
            material_ledger=FakeMaterialLedger(),
            generation_service=cast("GenerationService", object()),
            settled_records=cast("SettledRecords", object()),
            object_store=MemoryObjectStore(),
            http_client=idle_client(),
            fetch_url=as_is,
            resolve_principal=FakePrincipals(),
            shot_video=shot_video_settings,
            image_models=frozenset({"别的一家"}),
            media_codec=SOFTWARE,
        )


def test_video_mounts_without_generation_or_object_store(video_settings: ResolvedVideo) -> None:
    built = build_plugin_registry(
        workspace_store=FakeFileStore(),
        material_ledger=FakeMaterialLedger(),
        http_client=idle_client(),
        fetch_url=as_is,
        resolve_principal=FakePrincipals(),
        video=video_settings,
    )
    resolved = mount(("workspace", "video"), built)
    assert_kinds(resolved, [Workspace, Video])
    assert "shot_video" not in built
    video = resolved[1]
    assert isinstance(video, Video)
    assert set(video.get_toolset().tools) == {"video_parser"}
    display = build_display_registry(built)
    assert "video_parser" in display.entries
    assert "generate_shot_frames" not in display.entries
    assert built["video"].required_plugins() == ("workspace",)


def test_video_is_unavailable_without_understanding() -> None:
    built = build_plugin_registry(
        workspace_store=FakeFileStore(),
        material_ledger=FakeMaterialLedger(),
        http_client=idle_client(),
        fetch_url=as_is,
        resolve_principal=FakePrincipals(),
    )
    assert "video" not in built


def everything_registered(
    video_settings: ResolvedVideo, shot_video_settings: ResolvedShotVideo
) -> PluginRegistry:
    return build_plugin_registry(
        workspace_store=FakeFileStore(),
        material_ledger=FakeMaterialLedger(),
        generation_service=cast("GenerationService", object()),
        settled_records=cast("SettledRecords", object()),
        object_store=MemoryObjectStore(),
        http_client=idle_client(),
        fetch_url=as_is,
        resolve_principal=FakePrincipals(),
        video=video_settings,
        shot_video=shot_video_settings,
        iclip_studio=STUDIO,
        reference_service=cast("ReferenceService", RecordingReferences()),
        image_models=frozenset({IMAGE_MODEL}),
        media_codec=SOFTWARE,
    )


def test_each_plugin_class_is_registered_under_its_serialization_name(
    video_settings: ResolvedVideo, shot_video_settings: ResolvedShotVideo
) -> None:
    built = everything_registered(video_settings, shot_video_settings)

    assert list(built) == [
        "workspace",
        "iclip_studio",
        "video_shots",
        "video",
        "video_breakdown",
        "shot_video",
    ]
    for name, plugin in built.items():
        assert plugin.get_serialization_name() == name


def test_the_spec_schema_lists_every_plugin_without_its_services(
    video_settings: ResolvedVideo, shot_video_settings: ResolvedShotVideo
) -> None:
    """pydantic-ai 按 from_spec 的签名生成 spec schema；绑进类的服务不能出现成参数。"""

    built = everything_registered(video_settings, shot_video_settings)

    schema = AgentSpec.model_json_schema_with_capabilities(list(built.values()))

    entries = schema["properties"]["capabilities"]["items"]["anyOf"]
    for name in built:
        assert {"const": name, "type": "string"} in entries
    for service in ("space", "ledger", "probe", "breakdowns", "extractor", "understanding"):
        assert f'"{service}"' not in json.dumps(schema)


def run_deps() -> AgentRunDeps:
    return AgentRunDeps(
        user_id=STUDIO_PRINCIPAL.user_id, conversation_id="thread-1", user_name="logan"
    )


async def tools_seen(agent: Agent[AgentRunDeps, str]) -> list[str]:
    seen: list[str] = []

    def script(_messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        seen.extend(sorted(tool.name for tool in info.function_tools))
        return ModelResponse(parts=[TextPart("好")])

    await agent.run("看看你有什么", deps=run_deps(), model=FunctionModel(script))
    return seen


async def test_an_agent_from_the_native_spec_gets_the_same_tools_as_the_plugin_instances(
    video_settings: ResolvedVideo, shot_video_settings: ResolvedShotVideo
) -> None:
    built = everything_registered(video_settings, shot_video_settings)
    names = ("video_breakdown", "workspace", "shot_video", "video")

    from_spec = Agent.from_spec(
        AgentSpec.from_dict({"capabilities": [{name: {}} for name in names]}),
        custom_capability_types=list(built.values()),
        deps_type=AgentRunDeps,
        model=TestModel(),
    )
    from_instances = Agent(
        TestModel(), deps_type=AgentRunDeps, capabilities=list(mount(names, built))
    )

    seen = await tools_seen(from_spec)
    assert seen == await tools_seen(from_instances)
    assert {"breakdown_video", "read_file", "plan_shot_frames", "video_parser"} <= set(seen)


def test_pydantic_ai_rejects_a_leaf_plugin_without_its_requirements(
    video_settings: ResolvedVideo, shot_video_settings: ResolvedShotVideo
) -> None:
    """叶子插件的 get_ordering().requires 由 pydantic-ai 自己在装配时查。"""

    built = everything_registered(video_settings, shot_video_settings)

    with pytest.raises(UserError, match="requires `Video`"):
        Agent.from_spec(
            AgentSpec.from_dict({"capabilities": [{"workspace": {}}, {"shot_video": {}}]}),
            custom_capability_types=list(built.values()),
            model=TestModel(),
        )
