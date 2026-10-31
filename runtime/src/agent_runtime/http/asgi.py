"""uvicorn 的 app 工厂：``agent_runtime.http.asgi:app_from_env``（``factory=True``）。

配置文件路径来自 ``AGENT_RUNTIME_CONFIG``，由 ``agent_runtime.main`` 按 ``--config`` 写进去。

配置了 ``plugins`` 时，插件包的入口要在事件循环里打开（建连接、做启动检查），uvicorn 却是同步调这个工厂；
所以交回一层外壳 ``PluginsAtStartup``：lifespan 启动时打开插件包，用它的绑定函数建运行时 app 再启动它，
关停时倒序收尾。建 app 时的插件登记表因此就是绑好的那一份，管理接口与装配不必延后去读。
"""

from __future__ import annotations

import os
import traceback
from collections.abc import Callable
from contextlib import AbstractAsyncContextManager, AsyncExitStack
from pathlib import Path
from typing import Final, cast

import structlog
from fastapi import FastAPI
from starlette.types import ASGIApp, Receive, Scope, Send

from agent_runtime.http.app import create_app
from agent_runtime.http.logging import QUIET_LOGGERS, SERVICE_NAME, configure_logging
from agent_runtime.plugins.base import PluginBinder, PluginFactory
from agent_runtime.settings import PluginsSection, load_config, resolve_settings

CONFIG_ENV: Final = "AGENT_RUNTIME_CONFIG"

_logger = structlog.stdlib.get_logger(__name__)


class PluginsAtStartup:
    """ASGI 外壳：lifespan 启动时进入 ``open_plugins()`` 拿到绑定函数，交给 ``build`` 建出运行时 app，再跑它
    的 lifespan；关停时先停 app、再退出插件包（插件包借此关掉自己的连接）。其余请求原样转给建好的 app。

    任一步失败都按 ASGI lifespan 协议报 ``startup.failed``，已打开的倒序收尾，服务起不来。
    """

    def __init__(
        self,
        open_plugins: Callable[[], AbstractAsyncContextManager[PluginBinder]],
        build: Callable[[PluginBinder], FastAPI],
    ) -> None:
        self._open_plugins = open_plugins
        self._build = build
        self._app: FastAPI | None = None

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "lifespan":
            await self._lifespan(receive, send)
            return
        if self._app is None:
            raise RuntimeError("运行时服务还没启动完：插件登记表还没绑好")
        await self._app(scope, receive, send)

    async def _lifespan(self, receive: Receive, send: Send) -> None:
        await receive()  # lifespan.startup
        stack = AsyncExitStack()
        try:
            bind = await stack.enter_async_context(self._open_plugins())
            app = self._build(bind)
            await stack.enter_async_context(app.router.lifespan_context(app))
        except BaseException:
            # 与 Starlette 自己的 lifespan 同一做法：报失败带上栈，再把异常抛给服务器。
            await send({"type": "lifespan.startup.failed", "message": traceback.format_exc()})
            await stack.aclose()
            raise
        self._app = app
        await send({"type": "lifespan.startup.complete"})
        await receive()  # lifespan.shutdown
        try:
            await stack.aclose()
        except BaseException:
            await send({"type": "lifespan.shutdown.failed", "message": traceback.format_exc()})
            raise
        await send({"type": "lifespan.shutdown.complete"})


def app_from_env() -> ASGIApp:
    """读配置、建 app。

    没配 ``plugins`` 时插件登记表是空的：管理接口把配置里引用的每个插件都当作不存在，挂了插件的 agent
    发布不了。配了就交回 ``PluginsAtStartup``，启动时按 ``plugins.factory`` 打开插件包。
    """

    config = load_config(Path(os.environ[CONFIG_ENV]))
    settings = resolve_settings(config)
    # 插件包在建 app 之前打开，它的日志也要按配置的级别与格式出。
    configure_logging(
        settings.log_level, settings.log_format, service=SERVICE_NAME, quiet=QUIET_LOGGERS
    )
    if config.plugins is None:
        _logger.warning("没有配置插件包，插件登记表为空，挂了插件的 agent 配置一律校验不过")
        return create_app(settings, plugins={})
    return PluginsAtStartup(
        _opener(config.plugins), lambda bind: create_app(settings, plugins=bind)
    )


def _opener(section: PluginsSection) -> Callable[[], AbstractAsyncContextManager[PluginBinder]]:
    factory = cast("PluginFactory", section.factory)
    return lambda: factory(section.config)


__all__ = ["CONFIG_ENV", "PluginsAtStartup", "app_from_env"]
