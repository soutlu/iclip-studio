"""model_providers 的跨模块契约：其它模块只准从这里 import。"""

from __future__ import annotations

from iclip.domains.model_providers.catalog import (
    API_KEY_FIELD,
    BASE_URL_FIELD,
    Declarations,
    ProviderDeclaration,
    load_declarations,
)
from iclip.domains.model_providers.models import ProbeResult, ProviderModel, ResolvedProvider
from iclip.domains.model_providers.repository import CredentialProbe, ModelUsages
from iclip.domains.model_providers.service import ModelProviderService

__all__ = [
    "API_KEY_FIELD",
    "BASE_URL_FIELD",
    "CredentialProbe",
    "Declarations",
    "ModelProviderService",
    "ModelUsages",
    "ProbeResult",
    "ProviderDeclaration",
    "ProviderModel",
    "ResolvedProvider",
    "load_declarations",
]
