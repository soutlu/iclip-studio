from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from cue.client import RuntimeClient

from iclip.domains.model_providers.api import (
    create_default_models_router,
    create_model_providers_router,
)


@dataclass(frozen=True)
class ModelProvidersModule:
    routers: tuple[Any, ...]


def build_model_providers_module(runtime: RuntimeClient) -> ModelProvidersModule:
    return ModelProvidersModule(
        routers=(create_model_providers_router(runtime), create_default_models_router(runtime)),
    )


__all__ = ["ModelProvidersModule", "build_model_providers_module"]
