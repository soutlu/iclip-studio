"""model_providers 装配单元：组合根只调用 ``build_model_providers_module``。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from agent_runtime.client import RuntimeClient

from iclip.domains.model_providers.api import (
    create_default_models_router,
    create_model_providers_router,
)


@dataclass(frozen=True)
class ModelProvidersModule:
    routers: tuple[Any, ...]
    """使用 Any 隔离 Web 框架类型。"""


def build_model_providers_module(runtime: RuntimeClient) -> ModelProvidersModule:
    """端点都转给运行时服务，``runtime`` 是组合根建的那一个客户端。"""

    return ModelProvidersModule(
        routers=(create_model_providers_router(runtime), create_default_models_router(runtime)),
    )


__all__ = ["ModelProvidersModule", "build_model_providers_module"]
