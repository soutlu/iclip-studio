"""model_providers 的跨模块契约：其它模块只准从这里 import。"""

from __future__ import annotations

from agent_runtime.config.model_providers.catalog import (
    API_KEY_FIELD,
    BASE_URL_FIELD,
    Declarations,
    ProviderDeclaration,
    load_declarations,
)
from agent_runtime.config.model_providers.infra_sql import SqlModelProviderStore
from agent_runtime.config.model_providers.models import (
    ModelType,
    ProbeResult,
    ProviderModel,
    ResolvedProvider,
    RuntimeModel,
)
from agent_runtime.config.model_providers.repository import CredentialProbe, ModelUsages
from agent_runtime.config.model_providers.schemas import (
    CredentialCreateIn,
    CredentialOut,
    CredentialTestIn,
    CredentialUpdateIn,
    CustomModelCreateIn,
    DeclarationsOut,
    DefaultModelIn,
    DefaultModelOut,
    DefaultModelsOut,
    ModelOptionsOut,
    ModelProviderCreateIn,
    ModelProviderOut,
    ModelProvidersOut,
    ModelProviderUpdateIn,
    ModelUpdateIn,
    ProbeOut,
    ProviderModelOut,
)
from agent_runtime.config.model_providers.service import (
    ModelProviderService,
    rotate_credential_keys,
)

__all__ = [
    "API_KEY_FIELD",
    "BASE_URL_FIELD",
    "CredentialCreateIn",
    "CredentialOut",
    "CredentialProbe",
    "CredentialTestIn",
    "CredentialUpdateIn",
    "CustomModelCreateIn",
    "Declarations",
    "DeclarationsOut",
    "DefaultModelIn",
    "DefaultModelOut",
    "DefaultModelsOut",
    "ModelOptionsOut",
    "ModelProviderCreateIn",
    "ModelProviderOut",
    "ModelProviderService",
    "ModelProviderUpdateIn",
    "ModelProvidersOut",
    "ModelType",
    "ModelUpdateIn",
    "ModelUsages",
    "ProbeOut",
    "ProbeResult",
    "ProviderDeclaration",
    "ProviderModel",
    "ProviderModelOut",
    "ResolvedProvider",
    "RuntimeModel",
    "SqlModelProviderStore",
    "load_declarations",
    "rotate_credential_keys",
]
