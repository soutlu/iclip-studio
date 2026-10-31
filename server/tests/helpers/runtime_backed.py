"""后端 app 连同它调的运行时服务一起装：运行时 app 接同一个测试库与同一个 engine，经 ``httpx.ASGITransport``
挂在后端的运行时客户端上。

- 运行时 app 不跑 lifespan，不起第二个运行驱动；消息、transcript 与实时通道仍在后端进程内。
- 交给运行时的插件登记表就是后端 ``build_plugin_registry`` 建出的那一份（``app.state.plugin_registry``），
  管理接口校验插件与进程内装配看的是同一套插件；模型替身与试连替身也与后端用同一份。
- 运行时只认一个应用 ``video``，有管理权限，密钥是 ``RUNTIME_APP_KEY``（集成层 ``base_env`` 设进环境）。
"""

from __future__ import annotations

from typing import Any

import httpx
from agent_runtime.assembly.agents import ModelBuilder, build_runtime_model
from agent_runtime.config.model_providers.repository import CredentialProbe
from agent_runtime.http import create_app
from agent_runtime.settings import AgentRunsSection, CompactionSection, ResolvedApp, RuntimeSettings
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.app import bootstrap
from iclip.app.bootstrap import VIDEO_APP_ID
from iclip.config import RuntimeConfig
from tests.helpers.app import TEST_CREDENTIAL_KEY

RUNTIME_URL = "http://runtime.test"
"""后端测试环境里的 ``RUNTIME_URL``；请求经 ASGI 传输层直达进程内的运行时 app，不出网。"""

RUNTIME_APP_KEY = "runtime-video-app-key-0123456789-abcdef"
"""后端测试环境里的 ``RUNTIME_APP_KEY``，也是运行时配给应用 ``video`` 的密钥。"""


class LateASGITransport(httpx.AsyncBaseTransport):
    """先交给后端、后接上运行时 app 的传输层：运行时 app 要用后端建好的插件登记表，只能在后端之后建。

    ``raise_app_exceptions=False``：运行时没接住的异常照真实部署答 500，客户端库报成 ``RuntimeUnavailable``。"""

    def __init__(self) -> None:
        self._inner: httpx.ASGITransport | None = None

    def bind(self, app: FastAPI) -> None:
        self._inner = httpx.ASGITransport(app=app, raise_app_exceptions=False)

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if self._inner is None:
            raise RuntimeError("运行时 app 还没接上")
        return await self._inner.handle_async_request(request)

    async def aclose(self) -> None:
        if self._inner is not None:
            await self._inner.aclose()


def runtime_settings(config: RuntimeConfig, engine: AsyncEngine) -> RuntimeSettings:
    """运行时服务的设置：同一个库，一个有管理权限的应用 ``video``，技能缓存与日志同后端的配置。"""

    skill_cache_dir = config.agent_runs.skill_cache_dir
    return RuntimeSettings(
        database_url=engine.url.render_as_string(hide_password=False),
        credential_encryption_keys=(TEST_CREDENTIAL_KEY,),
        apps=(ResolvedApp(id=VIDEO_APP_ID, key=RUNTIME_APP_KEY, admin=True),),
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
    **options: Any,
) -> FastAPI:
    """照 ``build_app`` 装后端（``options`` 原样交给它），再装运行时 app 接上它的客户端。

    运行时 app 挂在后端的 ``app.state.runtime_service`` 上，测试要绕过后端直接问运行时时用。"""

    transport = LateASGITransport()
    app = bootstrap.build_app(
        config,
        engine=engine,
        build_model=build_model,
        credential_probe=credential_probe,
        runtime_transport=transport,
        **options,
    )
    runtime = create_app(
        runtime_settings(config, engine),
        plugins=app.state.plugin_registry,
        credential_probe=credential_probe,
        engine=engine,
        build_model=build_model,
    )
    transport.bind(runtime)
    app.state.runtime_service = runtime
    return app


__all__ = [
    "RUNTIME_APP_KEY",
    "RUNTIME_URL",
    "LateASGITransport",
    "build_backed_app",
    "runtime_settings",
]
