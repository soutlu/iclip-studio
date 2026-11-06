from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, cast

import httpx
import pytest
from agent_runtime.harness.background import BackgroundTools
from agent_runtime.model_connections import ModelConnection
from agent_runtime.plugins.base import PluginHost, PluginRegistry
from agent_runtime.plugins.workspace.capability import Workspace
from pydantic import ValidationError

from iclip_video.iclip_studio.capability import IclipStudio
from iclip_video.registry import (
    open_video_plugins,
)
from iclip_video.shot_video.generation import IMAGE_MODEL
from iclip_video.video.capability import Video
from iclip_video.video_breakdown.capability import VideoBreakdown, VideoBreakdownPlugin
from iclip_video.video_understanding import DECLARATION, MODEL
from tests.helpers.file_store import FakeFileStore
from tests.helpers.model_connections import FakeModelConnections

TOKEN = "runtime-internal-test-token-0123456789"
INTERNAL_API = {"base_url": "http://server.test", "token_env": "RUNTIME_INTERNAL_TOKEN"}
ALWAYS = {"workspace", "iclip_studio", "video_shots", "video"}
IMAGE_URL = "https://bucket.oss-ap-southeast-1.aliyuncs.com/style.jpg"
ARK = ModelConnection(responses_url="https://relay.example/api/v3/responses", api_key="sk-test-ark")


@pytest.fixture(autouse=True)
def secrets(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RUNTIME_INTERNAL_TOKEN", TOKEN)


SERVICES_PATH = "/internal/runtime/plugins/services"


@dataclass
class Server:
    models: tuple[str, ...] = (IMAGE_MODEL,)
    shot_video: bool = True
    video_breakdown: bool = True
    status: int = 200
    seen: list[httpx.Request] = field(default_factory=list[httpx.Request])

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.seen.append(request)
        if request.url.path == SERVICES_PATH:
            shot = {"image_models": list(self.models)} if self.shot_video else None
            return httpx.Response(
                self.status, json={"shot_video": shot, "video_breakdown": self.video_breakdown}
            )
        return httpx.Response(
            200,
            json={
                "FileSize": {"value": "1"},
                "Format": {"value": "png"},
                "ImageHeight": {"value": "1"},
                "ImageWidth": {"value": "1"},
            },
        )

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self)


def host(connections: FakeModelConnections | None = None) -> PluginHost:
    return PluginHost(files=FakeFileStore(), model_connection=connections or FakeModelConnections())


async def registry_for(config: dict[str, Any], server: Server | None = None) -> PluginRegistry:
    used = server if server is not None else Server()
    async with open_video_plugins(
        config, internal_transport=used.transport(), outbound_transport=used.transport()
    ) as bind:
        return bind(host())


async def test_without_optional_sections_only_the_always_on_plugins_are_registered() -> None:
    server = Server()

    registry = await registry_for({}, server)

    assert set(registry) == ALWAYS
    assert server.seen == [], "没有要后端的插件就不连后端"


@pytest.mark.parametrize(
    ("config", "extra"),
    [
        ({"internal_api": INTERNAL_API, "video_breakdown": {}}, {"video_breakdown"}),
        ({"internal_api": INTERNAL_API, "shot_video": {}}, {"shot_video"}),
        (
            {"internal_api": INTERNAL_API, "video_breakdown": {}, "shot_video": {}},
            {"video_breakdown", "shot_video"},
        ),
    ],
    ids=["video_breakdown", "shot_video", "all"],
)
async def test_each_optional_section_registers_its_plugin(
    config: dict[str, Any], extra: set[str]
) -> None:
    registry = await registry_for(config)

    assert set(registry) == ALWAYS | extra
    for name, plugin in registry.items():
        assert plugin.get_serialization_name() == name
        plugin.from_spec()


EVERYTHING = {"internal_api": INTERNAL_API, "video_breakdown": {}, "shot_video": {}}


async def test_the_generate_tool_is_not_offered_to_the_agent() -> None:
    registry = await registry_for(EVERYTHING)

    capability = registry["iclip_studio"].from_spec()
    assert isinstance(capability, IclipStudio)
    tools = capability.get_toolset().tools
    assert "generate_images" not in tools
    assert "check_film" in tools


async def test_video_breakdown_runs_in_the_background_and_requires_workspace() -> None:
    registry = await registry_for({"internal_api": INTERNAL_API, "video_breakdown": {}})

    plugin = registry["video_breakdown"].from_spec()
    assert isinstance(plugin, VideoBreakdownPlugin)
    capability, background = plugin.capabilities
    assert isinstance(capability, VideoBreakdown)
    assert isinstance(background, BackgroundTools), "breakdown_video 要挂着后台工具才在后台跑"
    assert isinstance(registry["iclip_studio"].from_spec(), IclipStudio), (
        "后台工具只跟着 video_breakdown 挂"
    )
    assert registry["video_breakdown"].required_plugins() == ("workspace",)


@pytest.mark.parametrize(
    "section", ["shot_video", "video_breakdown"], ids=["shot_video", "video_breakdown"]
)
async def test_a_plugin_that_needs_the_backend_asks_it_for_its_services_with_the_token(
    section: str,
) -> None:
    server = Server()

    await registry_for({"internal_api": INTERNAL_API, section: {}}, server)

    (request,) = server.seen
    assert str(request.url) == f"http://server.test{SERVICES_PATH}"
    assert request.headers["authorization"] == f"Bearer {TOKEN}"


@pytest.mark.parametrize(
    ("section", "backend", "fix"),
    [
        ("shot_video", Server(shot_video=False), "后端 config.yaml 要写 shot_video: {}"),
        ("video_breakdown", Server(video_breakdown=False), "后端 config.yaml 要写 iclip_studio 段"),
    ],
    ids=["shot_video", "video_breakdown"],
)
async def test_a_plugin_whose_backend_service_is_off_fails_at_startup_naming_the_fix(
    section: str, backend: Server, fix: str
) -> None:
    with pytest.raises(RuntimeError, match=f"配了 {section}") as raised:
        await registry_for({"internal_api": INTERNAL_API, section: {}}, backend)

    assert fix in str(raised.value)


async def test_both_missing_services_are_named_together() -> None:
    with pytest.raises(RuntimeError) as raised:
        await registry_for(
            {"internal_api": INTERNAL_API, "shot_video": {}, "video_breakdown": {}},
            Server(shot_video=False, video_breakdown=False),
        )

    assert "shot_video: {}" in str(raised.value)
    assert "iclip_studio" in str(raised.value)


@pytest.mark.parametrize(
    "error",
    [httpx.ConnectError("connection refused"), httpx.ConnectTimeout("timed out")],
    ids=["refused", "timeout"],
)
async def test_an_unreachable_backend_fails_shot_video_at_startup(error: httpx.HTTPError) -> None:
    def unreachable(_request: httpx.Request) -> httpx.Response:
        raise error

    with pytest.raises(
        RuntimeError, match="shot_video 启动时要向后端取它开了哪些插件服务"
    ) as raised:
        async with open_video_plugins(
            {"internal_api": INTERNAL_API, "shot_video": {}},
            internal_transport=httpx.MockTransport(unreachable),
        ):
            pytest.fail("后端连不上时不该交出绑定函数")

    assert type(error).__name__ in str(raised.value)


async def test_a_backend_error_fails_shot_video_at_startup() -> None:
    with pytest.raises(RuntimeError, match="答 401"):
        await registry_for({"internal_api": INTERNAL_API, "shot_video": {}}, Server(status=401))


async def test_shot_video_without_its_image_model_fails_to_bind() -> None:
    with pytest.raises(RuntimeError, match=f"出图工具要 {IMAGE_MODEL}") as raised:
        await registry_for(
            {"internal_api": INTERNAL_API, "shot_video": {}}, Server(models=("gpt-image-2.5",))
        )

    assert "gpt-image-2.5" in str(raised.value)


async def test_the_media_probe_goes_through_the_plain_client_and_the_rebased_address() -> None:
    server = Server()
    internal = "https://bucket.oss-ap-southeast-1-internal.aliyuncs.com"
    config = {
        "internal_api": INTERNAL_API,
        "oss": {
            "public_url_base": "https://bucket.oss-ap-southeast-1.aliyuncs.com",
            "internal_url_base": internal,
        },
    }
    async with open_video_plugins(
        config, internal_transport=server.transport(), outbound_transport=server.transport()
    ) as bind:
        workspace = cast("Workspace[Any]", bind(host())["workspace"].from_spec())
        await workspace.probe.image_info(IMAGE_URL)

    (request,) = server.seen
    assert str(request.url) == f"{internal}/style.jpg?x-oss-process=image/info"
    assert "authorization" not in request.headers


async def test_the_clients_are_closed_on_exit() -> None:
    async with open_video_plugins({}, outbound_transport=Server().transport()) as bind:
        workspace = cast("Workspace[Any]", bind(host())["workspace"].from_spec())

    with pytest.raises(RuntimeError, match="closed"):
        await workspace.probe.image_info(IMAGE_URL)


@pytest.mark.parametrize(
    ("config", "where"),
    [
        ({"shot_video": {}}, "internal_api"),
        ({"video_breakdown": {}}, "internal_api"),
        ({"unknown": {}}, "unknown"),
        ({"internal_api": {**INTERNAL_API, "token_env": "lower_case"}}, "token_env"),
        ({"shot_video": {"dev_attempts": 0}, "internal_api": INTERNAL_API}, "dev_attempts"),
    ],
    ids=["shot-without-api", "breakdown-without-api", "unknown-key", "env-name", "attempts"],
)
async def test_a_malformed_config_fails_on_entry(config: dict[str, Any], where: str) -> None:
    with pytest.raises(ValidationError, match=where):
        async with open_video_plugins(config):
            pytest.fail("配置不对时不该交出绑定函数")


@pytest.mark.parametrize(
    "section",
    [{}, {"understanding_url": "https://relay.example/responses", "model": "seed-vision"}],
    ids=["empty", "old-fields"],
)
async def test_a_video_section_is_rejected_with_how_to_fix_it(section: dict[str, Any]) -> None:
    with pytest.raises(ValidationError, match=r"video 段已去掉.*从 plugins\.config 里删掉它"):
        async with open_video_plugins({"video": section}):
            pytest.fail("配置不对时不该交出绑定函数")


async def test_a_missing_secret_names_its_variable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("RUNTIME_INTERNAL_TOKEN")

    with pytest.raises(RuntimeError, match="环境变量 RUNTIME_INTERNAL_TOKEN 没有设置"):
        async with open_video_plugins({"internal_api": INTERNAL_API}):
            pytest.fail("缺机密时不该交出绑定函数")


async def test_video_parses_through_the_hosts_connection_at_call_time() -> None:
    seen: list[httpx.Request] = []

    def ark(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            json={
                "status": "completed",
                "output": [{"content": [{"type": "output_text", "text": "## 拆解"}]}],
            },
        )

    connections = FakeModelConnections()
    async with open_video_plugins({}, outbound_transport=httpx.MockTransport(ark)) as bind:
        video = cast("Video[Any]", bind(host(connections))["video"].from_spec())
        assert connections.asked == [], "登记时不查连接"
        connections.connections[(DECLARATION, MODEL)] = ARK

        assert await video.understanding.parse("https://cdn.test/ref.mp4") == "## 拆解"

    assert connections.asked == [(DECLARATION, MODEL)]
    (request,) = seen
    assert str(request.url) == ARK.responses_url
    assert request.headers["Authorization"] == "Bearer sk-test-ark"


async def test_a_secret_pasted_into_the_config_is_not_echoed() -> None:
    with pytest.raises(ValidationError) as raised:
        async with open_video_plugins({"internal_api": {**INTERNAL_API, "token": TOKEN}}):
            pytest.fail("配置不对时不该交出绑定函数")

    assert "internal_api.token" in str(raised.value)
    assert TOKEN not in str(raised.value)
