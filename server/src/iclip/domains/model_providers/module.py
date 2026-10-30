"""model_providers 装配单元：组合根只调用 ``build_model_providers_module``。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from iclip.domains.model_providers.api import (
    create_default_models_router,
    create_model_providers_router,
)
from iclip.domains.model_providers.catalog import Declarations
from iclip.domains.model_providers.cipher import CredentialCipher
from iclip.domains.model_providers.repository import CredentialProbe, ModelProviderStore
from iclip.domains.model_providers.service import ModelProviderService


@dataclass(frozen=True)
class ModelProvidersModule:
    routers: tuple[Any, ...]
    """使用 Any 隔离 Web 框架类型。"""

    service: ModelProviderService


def build_model_providers_module(
    store: ModelProviderStore,
    *,
    declarations: Declarations,
    cipher: CredentialCipher,
    probe: CredentialProbe,
) -> ModelProvidersModule:
    """``declarations`` 由组合根在启动时读好（见 ``catalog.load_declarations``）。"""

    service = ModelProviderService(store, declarations=declarations, cipher=cipher, probe=probe)
    return ModelProvidersModule(
        routers=(create_model_providers_router(service), create_default_models_router(service)),
        service=service,
    )


__all__ = ["ModelProvidersModule", "build_model_providers_module"]
