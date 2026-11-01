"""后端 app 连同它调的运行时服务一起装，两边互相经 ASGI 传输层直达，不出网。

- 运行时 app 接同一个测试库与同一个 engine。后端的运行时客户端经 ``ASGIWebSocketTransport`` 接它（HTTP 与
  两条 WebSocket 同一个传输层）；运行时回调后端（开跑检查、运行开始、轮次开始）经 ``httpx.ASGITransport``
  接后端 app，地址是后端的内部接口，令牌是环境变量 ``RUNTIME_INTERNAL_TOKEN``（集成层 ``base_env`` 设好，
  后端缺了它起不来）。
- 插件登记表交给运行时：默认是视频插件包在没配任何可选段时登记的那三个（``standard_plugins``），绑上运行时
  服务的工作区与素材台账；要替身插件的测试给 ``plugins``。模型替身与试连替身两边共用一份。
- 不跑 lifespan 时（``httpx.ASGITransport`` 驱动后端）运行照样跑：运行时受理消息就起运行；只有两条
  WebSocket 要 lifespan。``TestClient`` 跑的是组合起来的 lifespan：先运行时（运行驱动与事件分发），再后端
  （事件流消费者），等事件流连上才交给测试。
- 运行时 app 挂在后端的 ``app.state.runtime_service`` 上；它的 ``transcript_store`` 另挂在后端
  ``app.state.transcript_store`` 上，测试照旧核对连接断开后实时状态有没有放开。
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Final

import httpx
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
from iclip_video.video_shots.capability import VideoShots
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.app import bootstrap
from iclip.app.bootstrap import VIDEO_APP_ID
from iclip.app.runtime_internal import RUNTIME_INTERNAL_PREFIX
from iclip.config import RuntimeConfig
from tests.helpers.app import TEST_CREDENTIAL_KEY

RUNTIME_URL = "http://runtime.test"
"""后端测试环境里的 ``RUNTIME_URL``；请求经 ASGI 传输层直达进程内的运行时 app，不出网。"""

RUNTIME_APP_KEY = "runtime-video-app-key-0123456789-abcdef"
"""后端测试环境里的 ``RUNTIME_APP_KEY``，也是运行时配给应用 ``video`` 的密钥。"""

RUNTIME_INTERNAL_TOKEN = "runtime-internal-test-token-0123456789"
"""后端测试环境里的 ``RUNTIME_INTERNAL_TOKEN``，也是运行时回调后端时带的令牌。"""

SERVER_URL: Final = "http://server.test"
"""运行时回调后端用的根地址；经 ASGI 传输层直达后端 app。"""

EVENTS_CONNECT_SECONDS: Final = 10.0
"""组合 lifespan 等后端连上事件流的上限。"""


class LateASGITransport(httpx.AsyncBaseTransport):
    """先交给运行时、后接上后端 app 的传输层：后端要用建好的运行时 app，只能在它之后建。

    ``raise_app_exceptions=False``：后端没接住的异常照真实部署答 500。"""

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
    """一次只握手一条 WebSocket：``ASGIWebSocketTransport`` 握手时先把这一次的 scope 记在实例上，再起任务去读，
    两条同时握手会让后一条的 scope 盖掉前一条的。HTTP 请求不排队。"""

    def __init__(self, app: FastAPI) -> None:
        # 握手要等运行时 accept；测试机忙时默认的 1 秒不够。
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
    """视频插件包在运行时配置没写任何可选段时登记的三个插件，绑上运行时服务的工作区与素材台账。

    查图片信息不出网：替身客户端一律答 404。"""

    space = FileSpace(store=host.files, namespace=workspace_namespace)
    offline = httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(404)))
    plugins = (
        Workspace.bind(
            space=space, probe=OssMediaProbe(offline, fetch_url=lambda url: url), ledger=host.ledger
        ),
        IclipStudio.bind(space=space, ledger=host.ledger, images=None),
        VideoShots.bind(space=space, ledger=host.ledger),
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
    """运行时服务的设置：同一个库，一个有管理权限的应用 ``video``，回调后端的内部接口，日志同后端的配置；
    ``skill_cache_dir`` 是技能缓存目录（给了就不碰系统临时目录）；``hooks=False`` 时不配回调，给只读统计、
    不跑消息的测试用。"""

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
    **options: Any,
) -> FastAPI:
    """先装运行时 app，再照 ``build_app`` 装后端（``options`` 原样交给它）接上它，最后把运行时的回调接到后端。

    ``skill_cache_dir`` 交给运行时（见 ``runtime_settings``）。交回的是后端 app，它的 lifespan 换成先运行时、
    后后端的组合。"""

    to_server = LateASGITransport()
    runtime = create_app(
        runtime_settings(config, engine, skill_cache_dir=skill_cache_dir),
        plugins=plugins,
        credential_probe=credential_probe,
        engine=engine,
        build_model=build_model,
        hook_transport=to_server,
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
    """后端 app 背后那个运行时服务的三块配置服务；种 agent 与直接改配置的测试用。"""

    return app.state.runtime_service.state.config_services


def agent_runtime_of(app: FastAPI) -> AgentRuntime:
    """后端 app 背后那个运行时服务的装配入口；核对装配缓存的测试用。"""

    return app.state.runtime_service.state.agent_runtime


@asynccontextmanager
async def runtime_admin(app: FastAPI, *, end_user: str) -> AsyncGenerator[httpx.AsyncClient]:
    """绕过后端、以应用 ``video`` 的身份代 ``end_user`` 直接问运行时的管理接口；路径相对 ``/v1/admin``。
    用来造出操作人是本系统里没有的人的记录。"""

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
