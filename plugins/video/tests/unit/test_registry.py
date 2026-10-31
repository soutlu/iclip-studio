"""运行时服务的插件入口：配置校验、各配置段登记哪些插件、出图要的模型在启动时核对，内部令牌只发给后端。"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, cast

import httpx
import pytest
from agent_runtime.harness.background import BackgroundTools
from agent_runtime.plugins.base import PluginHost, PluginRegistry
from agent_runtime.plugins.workspace.capability import Workspace
from pydantic import ValidationError

from iclip_video.iclip_studio.capability import IclipStudio
from iclip_video.registry import (
    open_video_plugins,
)
from iclip_video.shot_video.generation import IMAGE_MODEL
from iclip_video.video_breakdown.capability import VideoBreakdown, VideoBreakdownPlugin
from tests.helpers.file_store import FakeFileStore
from tests.helpers.material_ledger import FakeMaterialLedger

TOKEN = "runtime-internal-test-token-0123456789"
ARK_KEY = "ark-test-key"
INTERNAL_API = {"base_url": "http://server.test", "token_env": "RUNTIME_INTERNAL_TOKEN"}
VIDEO = {
    "understanding_url": "https://ark.test/responses",
    "api_key_env": "VIDEO_UNDERSTANDING_API_KEY",
    "model": "seed-vision",
}
ALWAYS = {"workspace", "iclip_studio", "video_shots"}
IMAGE_URL = "https://bucket.oss-ap-southeast-1.aliyuncs.com/style.jpg"


@pytest.fixture(autouse=True)
def secrets(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RUNTIME_INTERNAL_TOKEN", TOKEN)
    monkeypatch.setenv("VIDEO_UNDERSTANDING_API_KEY", ARK_KEY)


@dataclass
class Server:
    """后端与外部服务的替身：记下每个请求，图片模型名按 ``models`` 答，OSS 图片信息答一张图。"""

    models: tuple[str, ...] = (IMAGE_MODEL,)
    status: int = 200
    seen: list[httpx.Request] = field(default_factory=list[httpx.Request])

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.seen.append(request)
        if request.url.path == "/internal/runtime/plugins/image-models":
            return httpx.Response(self.status, json={"models": list(self.models)})
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


def host() -> PluginHost:
    return PluginHost(files=FakeFileStore(), ledger=FakeMaterialLedger())


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
        ({"video": VIDEO}, {"video"}),
        ({"internal_api": INTERNAL_API, "video_breakdown": {}}, {"video_breakdown"}),
        ({"internal_api": INTERNAL_API, "shot_video": {}}, {"shot_video"}),
        (
            {"internal_api": INTERNAL_API, "video": VIDEO, "video_breakdown": {}, "shot_video": {}},
            {"video", "video_breakdown", "shot_video"},
        ),
    ],
    ids=["video", "video_breakdown", "shot_video", "all"],
)
async def test_each_optional_section_registers_its_plugin(
    config: dict[str, Any], extra: set[str]
) -> None:
    registry = await registry_for(config)

    assert set(registry) == ALWAYS | extra
    for name, plugin in registry.items():
        assert plugin.get_serialization_name() == name
        plugin.from_spec()


EVERYTHING = {"internal_api": INTERNAL_API, "video": VIDEO, "video_breakdown": {}, "shot_video": {}}
"""每个可选段都写上：登记表里是全部插件。"""


async def test_the_generate_tool_is_not_offered_to_the_agent() -> None:
    """生图现阶段由人自己做：出图要的模型接上了也不登记生图工具，检查照常装配。"""

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


async def test_shot_video_asks_the_backend_for_its_image_models_with_the_internal_token() -> None:
    server = Server()

    await registry_for({"internal_api": INTERNAL_API, "shot_video": {}}, server)

    (request,) = server.seen
    assert str(request.url) == "http://server.test/internal/runtime/plugins/image-models"
    assert request.headers["authorization"] == f"Bearer {TOKEN}"


@pytest.mark.parametrize(
    "error",
    [httpx.ConnectError("connection refused"), httpx.ConnectTimeout("timed out")],
    ids=["refused", "timeout"],
)
async def test_an_unreachable_backend_fails_shot_video_at_startup(error: httpx.HTTPError) -> None:
    def unreachable(_request: httpx.Request) -> httpx.Response:
        raise error

    with pytest.raises(RuntimeError, match="shot_video 启动时要向后端取接入的图片模型") as raised:
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
    """查 OSS 不经内部接口的客户端：请求上没有内部令牌；本桶地址先换成内网地址。"""

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
        ({"video": {**VIDEO, "fps": 30}}, "fps"),
        ({"shot_video": {"dev_attempts": 0}, "internal_api": INTERNAL_API}, "dev_attempts"),
    ],
    ids=["shot-without-api", "breakdown-without-api", "unknown-key", "env-name", "fps", "attempts"],
)
async def test_a_malformed_config_fails_on_entry(config: dict[str, Any], where: str) -> None:
    with pytest.raises(ValidationError, match=where):
        async with open_video_plugins(config):
            pytest.fail("配置不对时不该交出绑定函数")


@pytest.mark.parametrize(
    ("config", "env"),
    [
        ({"internal_api": INTERNAL_API}, "RUNTIME_INTERNAL_TOKEN"),
        ({"video": VIDEO}, "VIDEO_UNDERSTANDING_API_KEY"),
    ],
)
async def test_a_missing_secret_names_its_variable(
    monkeypatch: pytest.MonkeyPatch, config: dict[str, Any], env: str
) -> None:
    monkeypatch.delenv(env)

    with pytest.raises(RuntimeError, match=f"环境变量 {env} 没有设置"):
        async with open_video_plugins(config):
            pytest.fail("缺机密时不该交出绑定函数")


async def test_a_secret_pasted_into_the_config_is_not_echoed() -> None:
    """配置里只收环境变量名；误把令牌本身写进去时，校验报错指出字段，不带它的值。"""

    with pytest.raises(ValidationError) as raised:
        async with open_video_plugins({"internal_api": {**INTERNAL_API, "token": TOKEN}}):
            pytest.fail("配置不对时不该交出绑定函数")

    assert "internal_api.token" in str(raised.value)
    assert TOKEN not in str(raised.value)
