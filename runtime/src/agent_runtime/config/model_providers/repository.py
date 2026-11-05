from __future__ import annotations

import uuid
from collections.abc import Callable, Mapping
from contextlib import AbstractAsyncContextManager
from typing import Protocol

from agent_runtime.agent_usage import ModelReference
from agent_runtime.config.model_providers.catalog import ProviderDeclaration
from agent_runtime.config.model_providers.models import (
    CredentialRecord,
    DefaultModel,
    ModelSetting,
    ModelType,
    ProbeResult,
    ProviderModel,
    ProviderState,
)


class ProviderEditor(Protocol):
    @property
    def state(self) -> ProviderState: ...

    @property
    def defaults(self) -> tuple[DefaultModel, ...]: ...

    async def update_provider(
        self, *, label: str, enabled: bool, default_credential_id: uuid.UUID | None
    ) -> None: ...

    async def insert_credential(
        self,
        credential_id: uuid.UUID,
        *,
        name: str,
        fields: Mapping[str, str],
        created_by: uuid.UUID,
    ) -> None: ...

    async def update_credential(
        self, credential_id: uuid.UUID, *, name: str, fields: Mapping[str, str]
    ) -> None: ...

    async def delete_credential(self, credential_id: uuid.UUID) -> None: ...

    async def put_model(self, setting: ModelSetting) -> None: ...

    async def delete_model(self, name: str, model_type: ModelType) -> None: ...

    async def set_default_model(self, model_type: ModelType, model_name: str) -> None: ...

    async def delete_provider(self) -> None: ...


class ModelProviderStore(Protocol):
    async def states(self) -> tuple[ProviderState, ...]: ...

    async def state(self, provider_id: uuid.UUID) -> ProviderState | None: ...

    async def insert_provider(
        self, provider_id: uuid.UUID, *, name: str, provider: str, label: str
    ) -> None: ...

    def edit(self, provider_id: uuid.UUID) -> AbstractAsyncContextManager[ProviderEditor]: ...

    async def default_models(self) -> tuple[DefaultModel, ...]: ...

    async def rewrite_credentials(
        self, rewrite: Callable[[str, CredentialRecord], Mapping[str, str]]
    ) -> int: ...


class CredentialProbe(Protocol):
    async def probe(
        self, declaration: ProviderDeclaration, model: ProviderModel, fields: Mapping[str, str]
    ) -> ProbeResult: ...


class ModelUsages(Protocol):
    async def model_references(self) -> tuple[ModelReference, ...]: ...


__all__ = ["CredentialProbe", "ModelProviderStore", "ModelUsages", "ProviderEditor"]
