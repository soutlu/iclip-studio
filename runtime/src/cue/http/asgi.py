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

from cue.http.app import create_app
from cue.http.logging import configure_logging
from cue.plugins.base import PluginBinder, PluginFactory
from cue.settings import PluginsSection, load_config, resolve_settings

CONFIG_ENV: Final = "CUE_CONFIG"

_logger = structlog.stdlib.get_logger(__name__)


class PluginsAtStartup:
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
        await receive()
        stack = AsyncExitStack()
        try:
            bind = await stack.enter_async_context(self._open_plugins())
            app = self._build(bind)
            await stack.enter_async_context(app.router.lifespan_context(app))
        except BaseException:
            await send({"type": "lifespan.startup.failed", "message": traceback.format_exc()})
            await stack.aclose()
            raise
        self._app = app
        await send({"type": "lifespan.startup.complete"})
        await receive()
        try:
            await stack.aclose()
        except BaseException:
            await send({"type": "lifespan.shutdown.failed", "message": traceback.format_exc()})
            raise
        await send({"type": "lifespan.shutdown.complete"})


def app_from_env() -> ASGIApp:
    config = load_config(Path(os.environ[CONFIG_ENV]))
    settings = resolve_settings(config)
    configure_logging(settings.log_level, settings.log_format)
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
