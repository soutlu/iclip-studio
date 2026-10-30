"""uvicorn 的 app 工厂：``agent_runtime.http.asgi:app_from_env``（``factory=True``）。

配置文件路径来自 ``AGENT_RUNTIME_CONFIG``，由 ``agent_runtime.main`` 按 ``--config`` 写进去。
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Final

import structlog
from fastapi import FastAPI

from agent_runtime.http.app import create_app
from agent_runtime.settings import load_config, resolve_settings

CONFIG_ENV: Final = "AGENT_RUNTIME_CONFIG"

_logger = structlog.stdlib.get_logger(__name__)


def app_from_env() -> FastAPI:
    """读配置、建 app。

    插件登记表目前是空的：插件由各应用的插件包提供，接进本服务之前，管理接口把配置里引用的每个插件都
    当作不存在，挂了插件的 agent 发布不了。
    """

    app = create_app(
        resolve_settings(load_config(Path(os.environ[CONFIG_ENV]))),
        plugins={},
    )
    _logger.warning("插件登记表为空，挂了插件的 agent 配置一律校验不过")
    return app


__all__ = ["CONFIG_ENV", "app_from_env"]
