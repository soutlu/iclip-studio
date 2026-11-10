from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Final

import httpx
import httpx2
from agent_runtime.assembly.agents import AgentRuntime, ModelBuilder, build_runtime_model
from agent_runtime.assembly.config_services import ConfigServices
from agent_runtime.config.model_providers.repository import CredentialProbe
from agent_runtime.file_store.store import FileSpace
from agent_runtime.http.app import create_app
from agent_runtime.plugins.base import PluginBinder, PluginHost, PluginRegistry
from agent_runtime.plugins.workspace.capability import Workspace
from agent_runtime.plugins.workspace.scope import workspace_namespace
from agent_runtime.settings import (
    AgentRunsSection,
    CompactionSection,
    ResolvedApp,
    ResolvedHooks,
    RuntimeSettings,
)
from fastapi import FastAPI
from httpx_ws.transport import ASGIWebSocketTransport
from iclip_video.iclip_studio.capability import IclipStudio
from iclip_video.oss_media import OssMediaProbe
from iclip_video.video.capability import Video
from iclip_video.video_shots.capability import VideoShots
from iclip_video.video_understanding import ArkVideoUnderstanding
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.app import bootstrap
from iclip.app.bootstrap import VIDEO_APP_ID
from iclip.app.runtime_internal import RUNTIME_INTERNAL_PREFIX
from iclip.config import RuntimeConfig
from tests.helpers.app import TEST_CREDENTIAL_KEY
from tests.helpers.media_probe import ScriptedProbe

RUNTIME_URL = "http://runtime.test"

RUNTIME_APP_KEY = "runtime-video-app-key-0123456789-abcdef"

RUNTIME_INTERNAL_TOKEN = "runtime-internal-test-token-0123456789"

SERVER_URL: Final = "http://server.test"

EVENTS_CONNECT_SECONDS: Final = 10.0


class LateASGITransport(httpx.AsyncBaseTransport):
    def __init__(self) -> None:
        self._inner: httpx.ASGITransport | None = None

    def bind(self, app: FastAPI) -> None:
        self._inner = httpx.ASGITransport(app=app, raise_app_exceptions=False)

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if self._inner is None:
            raise RuntimeError("后端 app 还没接上")
        return await self._inner.handle_async_request(request)

    async def aclose(self) -> None:
        if self._inner is not None:
            await self._inner.aclose()


class OneUpgradeAtATime(ASGIWebSocketTransport):
    def __init__(self, app: FastAPI) -> None:
        super().__init__(app=app, raise_app_exceptions=False, initial_receive_timeout=10.0)
        self._upgrading: asyncio.Lock | None = None

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if request.headers.get("upgrade") != "websocket":
            return await super().handle_async_request(request)
        if self._upgrading is None:
            self._upgrading = asyncio.Lock()
        async with self._upgrading:
            return await super().handle_async_request(request)


def standard_plugins(host: PluginHost) -> PluginRegistry:
    space = FileSpace(store=host.files, namespace=workspace_namespace)
    offline = httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(404)))
    plugins = (
        Workspace.bind(space=space, probe=OssMediaProbe(offline, fetch_url=lambda url: url)),
        IclipStudio.bind(space=space, images=None),
        VideoShots.bind(space=space),
        Video.bind(
            space=space,
            understanding=ArkVideoUnderstanding(offline, connection=host.model_connection),
        ),
    )
    return {plugin.get_serialization_name(): plugin for plugin in plugins}


def _hooks() -> ResolvedHooks:
    base = f"{SERVER_URL}{RUNTIME_INTERNAL_PREFIX}/hooks"
    return ResolvedHooks(
        token=os.environ["RUNTIME_INTERNAL_TOKEN"].strip(),
        gate=f"{base}/gate",
        run_started=f"{base}/run-started",
        turn_started=f"{base}/turn-started",
    )


def runtime_settings(
    config: RuntimeConfig,
    engine: AsyncEngine,
    *,
    skill_cache_dir: Path | None = None,
    hooks: bool = True,
) -> RuntimeSettings:
    return RuntimeSettings(
        database_url=engine.url.render_as_string(hide_password=False),
        credential_encryption_keys=(TEST_CREDENTIAL_KEY,),
        apps=(
            ResolvedApp(
                id=VIDEO_APP_ID, key=RUNTIME_APP_KEY, admin=True, hooks=_hooks() if hooks else None
            ),
        ),
        agent_runs=AgentRunsSection()
        if skill_cache_dir is None
        else AgentRunsSection(skill_cache_dir=skill_cache_dir),
        compaction=CompactionSection(),
        log_level=config.ops.log_level,
        log_format=config.ops.log_format,
    )


def build_backed_app(
    config: RuntimeConfig,
    *,
    engine: AsyncEngine,
    build_model: ModelBuilder = build_runtime_model,
    credential_probe: CredentialProbe | None = None,
    plugins: PluginRegistry | PluginBinder = standard_plugins,
    skill_cache_dir: Path | None = None,
    oauth_transport: httpx2.AsyncBaseTransport | None = None,
    **options: Any,
) -> FastAPI:
    options.setdefault("media_probe", ScriptedProbe())
    to_server = LateASGITransport()
    runtime = create_app(
        runtime_settings(config, engine, skill_cache_dir=skill_cache_dir),
        plugins=plugins,
        credential_probe=credential_probe,
        engine=engine,
        build_model=build_model,
        hook_transport=to_server,
        oauth_transport=oauth_transport,
    )
    app = bootstrap.build_app(
        config, engine=engine, runtime_transport=OneUpgradeAtATime(runtime), **options
    )
    to_server.bind(app)
    app.state.runtime_service = runtime
    app.state.transcript_store = runtime.state.transcript_store

    server_lifespan = app.router.lifespan_context

    @asynccontextmanager
    async def both(target: FastAPI) -> AsyncGenerator[None]:
        async with runtime.router.lifespan_context(runtime), server_lifespan(target):
            async with asyncio.timeout(EVENTS_CONNECT_SECONDS):
                await app.state.runtime_events.wait_connected()
            yield

    app.router.lifespan_context = both
    return app


def config_services_of(app: FastAPI) -> ConfigServices:
    return app.state.runtime_service.state.config_services


def agent_runtime_of(app: FastAPI) -> AgentRuntime:
    return app.state.runtime_service.state.agent_runtime


@asynccontextmanager
async def runtime_admin(app: FastAPI, *, end_user: str) -> AsyncGenerator[httpx.AsyncClient]:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app.state.runtime_service),
        base_url=f"{RUNTIME_URL}/v1/admin",
        headers={"Authorization": f"Bearer {RUNTIME_APP_KEY}", "X-End-User": end_user},
    ) as client:
        yield client


__all__ = [
    "RUNTIME_APP_KEY",
    "RUNTIME_INTERNAL_TOKEN",
    "RUNTIME_URL",
    "SERVER_URL",
    "LateASGITransport",
    "OneUpgradeAtATime",
    "agent_runtime_of",
    "build_backed_app",
    "config_services_of",
    "runtime_admin",
    "runtime_settings",
    "standard_plugins",
]
