from __future__ import annotations

import os
from collections.abc import AsyncGenerator, Callable, Mapping
from contextlib import AsyncExitStack, asynccontextmanager
from typing import Annotated, Any, Final, Self

import httpx
from cue.file_store.store import FileSpace
from cue.plugins.base import CapPlugin, PluginBinder, PluginHost, PluginRegistry
from cue.plugins.workspace.capability import Workspace
from cue.plugins.workspace.scope import workspace_namespace
from pydantic import BaseModel, ConfigDict, Field, HttpUrl, StringConstraints, model_validator

from iclip_video.iclip_studio.capability import IclipStudio
from iclip_video.internal_api import (
    CONNECT_TIMEOUT_SECONDS,
    HttpFrameBoards,
    HttpGridCuts,
    HttpImageGenerations,
    HttpReferenceBreakdowns,
    InternalApi,
    InternalApiError,
    plugin_services,
)
from iclip_video.oss_media import OssMediaProbe, rebased_fetch_url
from iclip_video.shot_video.capability import GenerationPolicy, ShotVideo
from iclip_video.video.capability import Video
from iclip_video.video_breakdown.capability import VideoBreakdownPlugin
from iclip_video.video_shots.capability import VideoShots
from iclip_video.video_understanding import ArkVideoUnderstanding

DEFAULT_INTERNAL_TIMEOUT_SECONDS: Final = 1800.0

EnvName = Annotated[str, StringConstraints(pattern=r"^[A-Z_][A-Z0-9_]*$")]


class _Section(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid", hide_input_in_errors=True)


class InternalApiSection(_Section):
    base_url: HttpUrl

    token_env: EnvName

    timeout_seconds: float = Field(default=DEFAULT_INTERNAL_TIMEOUT_SECONDS, gt=0)


class OssSection(_Section):
    public_url_base: HttpUrl
    internal_url_base: HttpUrl


class VideoBreakdownSection(_Section):
    pass


class ShotVideoSection(_Section):
    poll_interval_seconds: float = Field(default=5.0, gt=0)
    dev_attempts: int = Field(default=2, ge=1)
    pro_attempts: int = Field(default=1, ge=0)
    backoff_seconds: float = Field(default=5.0, gt=0)
    backoff_factor: float = Field(default=3.0, ge=1)
    job_timeout_seconds: float = Field(default=1800.0, gt=0)


class VideoPluginsConfig(_Section):
    internal_api: InternalApiSection | None = None

    oss: OssSection | None = None
    video_breakdown: VideoBreakdownSection | None = None
    shot_video: ShotVideoSection | None = None

    @model_validator(mode="before")
    @classmethod
    def _no_video_section(cls, data: Any) -> Any:
        if isinstance(data, Mapping) and "video" in data:
            raise ValueError(
                "video 段已去掉：视频理解总是登记，模型写在代码里，连接用配置页的火山方舟；"
                "从 plugins.config 里删掉它"
            )
        return data

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
        models = await _check_backend(api, settings)

        def bind(host: PluginHost) -> PluginRegistry:
            return _registry(host, settings, outbound=outbound, api=api, image_models=models)

        yield bind


def _internal_client(
    section: InternalApiSection, transport: httpx.AsyncBaseTransport | None
) -> httpx.AsyncClient:
    token = _secret(section.token_env, "后端内部令牌")
    return httpx.AsyncClient(
        transport=transport,
        base_url=str(section.base_url),
        headers={"Authorization": f"Bearer {token}"},
        timeout=httpx.Timeout(section.timeout_seconds, connect=CONNECT_TIMEOUT_SECONDS),
        limits=httpx.Limits(max_connections=None, max_keepalive_connections=20),
    )


def _registry(
    host: PluginHost,
    settings: VideoPluginsConfig,
    *,
    outbound: httpx.AsyncClient,
    api: InternalApi | None,
    image_models: frozenset[str],
) -> PluginRegistry:
    space = FileSpace(store=host.files, namespace=workspace_namespace)
    plugins: list[type[CapPlugin[Any]]] = [
        Workspace.bind(
            space=space, probe=OssMediaProbe(outbound, fetch_url=_fetch_url(settings.oss))
        ),
        IclipStudio.bind(space=space, images=None),
        VideoShots.bind(space=space),
        Video.bind(
            space=space,
            understanding=ArkVideoUnderstanding(outbound, connection=host.model_connection),
        ),
    ]
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


async def _check_backend(api: InternalApi | None, settings: VideoPluginsConfig) -> frozenset[str]:
    wanted = [
        name
        for name, section in (
            ("shot_video", settings.shot_video),
            ("video_breakdown", settings.video_breakdown),
        )
        if section is not None
    ]
    if not wanted:
        return frozenset()
    names = " 与 ".join(wanted)
    try:
        services = await plugin_services(_require(api, names))
    except InternalApiError as exc:
        raise RuntimeError(f"{names} 启动时要向后端取它开了哪些插件服务，没取到：{exc}") from exc
    missing: list[str] = []
    if settings.shot_video is not None and services.shot_video is None:
        missing.append(
            "配了 shot_video，后端没开取帧与出图：后端 config.yaml 要写 shot_video: {}，"
            "并开媒体生成与对象存储"
        )
    if settings.video_breakdown is not None and not services.video_breakdown:
        missing.append(
            "配了 video_breakdown，后端没开参考视频拆解：后端 config.yaml 要写 iclip_studio 段"
        )
    if missing:
        raise RuntimeError("；".join(missing))
    if services.shot_video is None:
        return frozenset()
    return frozenset(services.shot_video.image_models)


def _fetch_url(section: OssSection | None) -> Callable[[str], str]:
    if section is None:
        return _as_is
    return rebased_fetch_url(str(section.public_url_base), str(section.internal_url_base))


def _as_is(url: str) -> str:
    return url


def _require(api: InternalApi | None, plugin: str) -> InternalApi:
    if api is None:
        raise RuntimeError(f"{plugin} 要经后端内部接口干活，但没配 internal_api")
    return api


def _secret(env_name: str, what: str) -> str:
    value = os.environ.get(env_name, "").strip()
    if not value:
        raise RuntimeError(f"{what}的环境变量 {env_name} 没有设置")
    return value


__all__ = [
    "DEFAULT_INTERNAL_TIMEOUT_SECONDS",
    "InternalApiSection",
    "OssSection",
    "ShotVideoSection",
    "VideoBreakdownSection",
    "VideoPluginsConfig",
    "open_video_plugins",
]
