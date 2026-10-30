"""视频插件包给运行时服务的入口：运行时配置写 ``plugins.factory: iclip_video.registry:open_video_plugins``，
``plugins.config`` 按 ``VideoPluginsConfig`` 校验。

登记的插件与登记条件同后端进程内的插件登记表（``iclip.app.plugin_registry``）：``workspace``、
``iclip_studio`` 与 ``video_shots`` 总是登记，``video``、``video_breakdown`` 与 ``shot_video`` 各按自己的配置段
登记。要后端服务的端口经内部接口（``internal_api``）的 HTTP 客户端；``iclip_studio`` 不接生图（后端不开放这
条接口），生图工具照旧不登记。
"""

from __future__ import annotations

import os
from collections.abc import AsyncGenerator, Callable, Mapping
from contextlib import AsyncExitStack, asynccontextmanager
from typing import Annotated, Any, Final, Literal, Self

import httpx
from agent_runtime.file_store.store import FileSpace
from agent_runtime.plugins.base import CapPlugin, PluginBinder, PluginHost, PluginRegistry
from agent_runtime.plugins.workspace.capability import Workspace
from agent_runtime.plugins.workspace.scope import workspace_namespace
from pydantic import BaseModel, ConfigDict, Field, HttpUrl, StringConstraints, model_validator

from iclip_video.iclip_studio.capability import IclipStudio
from iclip_video.internal_api import (
    HttpFrameBoards,
    HttpGridCuts,
    HttpImageGenerations,
    HttpReferenceBreakdowns,
    InternalApi,
    InternalApiError,
    image_models,
)
from iclip_video.oss_media import OssMediaProbe, rebased_fetch_url
from iclip_video.shot_video.capability import GenerationPolicy, ShotVideo
from iclip_video.video.capability import Video
from iclip_video.video_breakdown.capability import VideoBreakdownPlugin
from iclip_video.video_shots.capability import VideoShots
from iclip_video.video_understanding import TIMEOUT_SECONDS, ArkVideoUnderstanding

DEFAULT_INTERNAL_TIMEOUT_SECONDS: Final = 1800.0
"""调后端内部接口等答复的默认上限。后端最慢的两条都要等：拆解排队后最多等 20 分钟才答，取帧拼板下载视频
最多 5 分钟、抽帧最多 15 分钟。"""

CONNECT_TIMEOUT_SECONDS: Final = 10.0
"""连后端内部接口建连的上限。"""

EnvName = Annotated[str, StringConstraints(pattern=r"^[A-Z_][A-Z0-9_]*$")]


class _Section(BaseModel):
    # 机密只该以环境变量名出现；误把值本身写进配置时，校验报错也不带出来。
    model_config = ConfigDict(frozen=True, extra="forbid", hide_input_in_errors=True)


class InternalApiSection(_Section):
    """后端给运行时的内部接口（conventions §21）。"""

    base_url: HttpUrl
    """后端的根地址，插件服务在它下面的 ``/internal/runtime/plugins``。"""

    token_env: EnvName
    """放内部令牌（后端的 ``RUNTIME_INTERNAL_TOKEN``）的环境变量名。"""

    timeout_seconds: float = Field(default=DEFAULT_INTERNAL_TIMEOUT_SECONDS, gt=0)


class OssSection(_Section):
    """本桶对象的公网地址前缀与内网地址前缀：查图片信息前把前者换成后者。不写就原样访问。"""

    public_url_base: HttpUrl
    internal_url_base: HttpUrl


class VideoSection(_Section):
    """视频理解（``video`` 插件）用的方舟接口。"""

    understanding_url: HttpUrl
    api_key_env: EnvName
    """放方舟 API key 的环境变量名。"""

    model: str = Field(min_length=1)
    thinking: Literal["minimal", "low", "medium", "high"] | None = None
    fps: float | None = Field(default=None, ge=0.2, le=5)
    timeout_seconds: float = Field(default=TIMEOUT_SECONDS, gt=0)


class VideoBreakdownSection(_Section):
    """写了就登记 ``video_breakdown``：拆解经内部接口交给后端的参考视频，与资料库共用一份。"""


class ShotVideoSection(_Section):
    """写了就登记 ``shot_video``，字段是出图的重试策略，默认值同后端的 ``shot_video`` 配置段。"""

    poll_interval_seconds: float = Field(default=5.0, gt=0)
    dev_attempts: int = Field(default=2, ge=1)
    pro_attempts: int = Field(default=1, ge=0)
    backoff_seconds: float = Field(default=5.0, gt=0)
    backoff_factor: float = Field(default=3.0, ge=1)
    job_timeout_seconds: float = Field(default=1800.0, gt=0)


class VideoPluginsConfig(_Section):
    """运行时配置里 ``plugins.config`` 的形状。机密只写放它的环境变量名。"""

    internal_api: InternalApiSection | None = None
    """挂 ``video_breakdown`` 或 ``shot_video`` 时必填。"""

    oss: OssSection | None = None
    video: VideoSection | None = None
    video_breakdown: VideoBreakdownSection | None = None
    shot_video: ShotVideoSection | None = None

    @model_validator(mode="after")
    def _internal_api_when_needed(self) -> Self:
        if self.internal_api is None and (
            self.video_breakdown is not None or self.shot_video is not None
        ):
            raise ValueError(
                "配了 video_breakdown 或 shot_video 就要配 internal_api：它们经后端干活"
            )
        return self


@asynccontextmanager
async def open_video_plugins(
    config: Mapping[str, Any],
    *,
    internal_transport: httpx.AsyncBaseTransport | None = None,
    outbound_transport: httpx.AsyncBaseTransport | None = None,
) -> AsyncGenerator[PluginBinder]:
    """``agent_runtime.plugins.base.PluginFactory`` 的实现。

    进入时校验配置、读机密的环境变量，建两个 HTTP 客户端：调后端内部接口的那个带根地址、令牌与超时，
    查 OSS 与调方舟的那个什么都不带，令牌不会发到别处去。配了 ``shot_video`` 时向后端取接入的图片模型，
    交回的绑定函数用它核对出图要的那家。退出时关掉两个客户端。``internal_transport`` 与
    ``outbound_transport`` 是测试换传输层的口子。

    Raises:
        pydantic.ValidationError: 配置形状不对。
        RuntimeError: 机密的环境变量没设置；配了 ``shot_video`` 却取不到图片模型；绑定时出图要的模型不在
            后端接入的模型里。
    """

    settings = VideoPluginsConfig.model_validate(config)
    async with AsyncExitStack() as stack:
        outbound = await stack.enter_async_context(
            httpx.AsyncClient(transport=outbound_transport, follow_redirects=True)
        )
        api = (
            InternalApi(
                await stack.enter_async_context(
                    _internal_client(settings.internal_api, internal_transport)
                )
            )
            if settings.internal_api is not None
            else None
        )
        understanding = (
            _understanding(settings.video, outbound) if settings.video is not None else None
        )
        models = await _image_models(api) if settings.shot_video is not None else frozenset()

        def bind(host: PluginHost) -> PluginRegistry:
            return _registry(
                host,
                settings,
                outbound=outbound,
                api=api,
                understanding=understanding,
                image_models=models,
            )

        yield bind


def _internal_client(
    section: InternalApiSection, transport: httpx.AsyncBaseTransport | None
) -> httpx.AsyncClient:
    token = _secret(section.token_env, "后端内部令牌")
    return httpx.AsyncClient(
        transport=transport,
        base_url=str(section.base_url),
        headers={"Authorization": f"Bearer {token}"},
        # 建连另有短上限：后端地址不通时启动检查立刻失败，不等满整段答复上限。
        timeout=httpx.Timeout(section.timeout_seconds, connect=CONNECT_TIMEOUT_SECONDS),
    )


def _understanding(section: VideoSection, client: httpx.AsyncClient) -> ArkVideoUnderstanding:
    return ArkVideoUnderstanding(
        client,
        url=str(section.understanding_url),
        api_key=_secret(section.api_key_env, "视频理解的 API key"),
        model=section.model,
        thinking=section.thinking,
        fps=section.fps,
        timeout_seconds=section.timeout_seconds,
    )


def _registry(
    host: PluginHost,
    settings: VideoPluginsConfig,
    *,
    outbound: httpx.AsyncClient,
    api: InternalApi | None,
    understanding: ArkVideoUnderstanding | None,
    image_models: frozenset[str],
) -> PluginRegistry:
    # 文件生产与读取共用 FileSpace，避免命名空间不一致。
    space = FileSpace(store=host.files, namespace=workspace_namespace)
    plugins: list[type[CapPlugin[Any]]] = [
        Workspace.bind(
            space=space,
            probe=OssMediaProbe(outbound, fetch_url=_fetch_url(settings.oss)),
            ledger=host.ledger,
        ),
        IclipStudio.bind(space=space, ledger=host.ledger, images=None),
        VideoShots.bind(space=space, ledger=host.ledger),
    ]
    if understanding is not None:
        plugins.append(Video.bind(space=space, ledger=host.ledger, understanding=understanding))
    if settings.video_breakdown is not None:
        plugins.append(
            VideoBreakdownPlugin.bind(
                space=space, breakdowns=HttpReferenceBreakdowns(_require(api, "video_breakdown"))
            )
        )
    if settings.shot_video is not None:
        shot = settings.shot_video
        backend = _require(api, "shot_video")
        plugins.append(
            ShotVideo.bind(
                space=space,
                ledger=host.ledger,
                generations=HttpImageGenerations(backend),
                boards=HttpFrameBoards(backend),
                cuts=HttpGridCuts(backend),
                image_models=image_models,
                policy=GenerationPolicy(
                    poll_interval_seconds=shot.poll_interval_seconds,
                    dev_attempts=shot.dev_attempts,
                    pro_attempts=shot.pro_attempts,
                    backoff_seconds=shot.backoff_seconds,
                    backoff_factor=shot.backoff_factor,
                    total_timeout_seconds=shot.job_timeout_seconds,
                ),
            )
        )
    return {plugin.get_serialization_name(): plugin for plugin in plugins}


async def _image_models(api: InternalApi | None) -> frozenset[str]:
    """出图工具启动时核对它要的模型后端接没接；取不到就起不来，不带着一件注定失败的工具跑。"""

    try:
        return await image_models(_require(api, "shot_video"))
    except InternalApiError as exc:
        raise RuntimeError(f"shot_video 启动时要向后端取接入的图片模型，没取到：{exc}") from exc


def _fetch_url(section: OssSection | None) -> Callable[[str], str]:
    if section is None:
        return _as_is
    return rebased_fetch_url(str(section.public_url_base), str(section.internal_url_base))


def _as_is(url: str) -> str:
    return url


def _require(api: InternalApi | None, plugin: str) -> InternalApi:
    # 配置校验已拦住这种写法；直接建 VideoPluginsConfig 绕过校验时照样报错。
    if api is None:
        raise RuntimeError(f"{plugin} 要经后端内部接口干活，但没配 internal_api")
    return api


def _secret(env_name: str, what: str) -> str:
    """读环境变量里的机密；报错只带变量名，不带值。"""

    value = os.environ.get(env_name, "").strip()
    if not value:
        raise RuntimeError(f"{what}的环境变量 {env_name} 没有设置")
    return value


__all__ = [
    "CONNECT_TIMEOUT_SECONDS",
    "DEFAULT_INTERNAL_TIMEOUT_SECONDS",
    "InternalApiSection",
    "OssSection",
    "ShotVideoSection",
    "VideoBreakdownSection",
    "VideoPluginsConfig",
    "VideoSection",
    "open_video_plugins",
]
