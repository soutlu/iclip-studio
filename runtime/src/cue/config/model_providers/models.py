from __future__ import annotations

import re
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Final, Literal

from cue.model_vocab import ModelApi, ThinkingEffort

if TYPE_CHECKING:
    from cue.config.model_providers.catalog import ProviderDeclaration

ModelType = Literal["llm", "embedding", "rerank"]

ModelSource = Literal["declared", "custom"]

SOURCE_DECLARED: Final = "declared"
SOURCE_CUSTOM: Final = "custom"

CredentialFieldType = Literal["secret", "text"]

FIELD_SECRET: Final = "secret"

PROVIDER_NAME_PATTERN: Final = re.compile(r"^[a-z0-9-]{1,64}$")

MAX_LABEL_CHARS: Final = 50
MAX_CREDENTIAL_NAME_CHARS: Final = 50
MAX_MODEL_NAME_CHARS: Final = 200
MAX_FIELD_VALUE_CHARS: Final = 2000


@dataclass(frozen=True, slots=True)
class ModelProperties:
    api: ModelApi | None
    context_size: int | None
    thinking: tuple[ThinkingEffort, ...]


@dataclass(frozen=True, slots=True)
class ProviderModel:
    name: str
    type: ModelType
    source: ModelSource
    properties: ModelProperties
    enabled: bool


@dataclass(frozen=True, slots=True)
class ProviderRecord:
    id: uuid.UUID
    name: str
    provider: str
    label: str
    default_credential_id: uuid.UUID | None
    enabled: bool
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class CredentialRecord:
    id: uuid.UUID
    provider_id: uuid.UUID
    name: str
    fields: Mapping[str, str]
    created_by: uuid.UUID
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class ModelSetting:
    name: str
    type: ModelType
    source: ModelSource
    properties: ModelProperties | None
    enabled: bool


@dataclass(frozen=True, slots=True)
class DefaultModel:
    type: ModelType
    provider_id: uuid.UUID
    provider_name: str
    model_name: str
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class ProviderState:
    provider: ProviderRecord
    credentials: tuple[CredentialRecord, ...]
    settings: tuple[ModelSetting, ...]


@dataclass(frozen=True, slots=True)
class ResolvedProvider:
    provider: ProviderRecord
    credential_ids: tuple[uuid.UUID, ...]
    models: tuple[ProviderModel, ...]


@dataclass(frozen=True, slots=True)
class RuntimeModel:
    declaration: ProviderDeclaration
    provider: ProviderRecord
    model: ProviderModel
    credential_id: uuid.UUID
    credential_updated_at: datetime
    fields: Mapping[str, str]


@dataclass(frozen=True, slots=True)
class ProbeResult:
    ok: bool
    elapsed_ms: int
    reason: str | None = None


__all__ = [
    "FIELD_SECRET",
    "MAX_CREDENTIAL_NAME_CHARS",
    "MAX_FIELD_VALUE_CHARS",
    "MAX_LABEL_CHARS",
    "MAX_MODEL_NAME_CHARS",
    "PROVIDER_NAME_PATTERN",
    "SOURCE_CUSTOM",
    "SOURCE_DECLARED",
    "CredentialFieldType",
    "CredentialRecord",
    "DefaultModel",
    "ModelProperties",
    "ModelSetting",
    "ModelSource",
    "ModelType",
    "ProbeResult",
    "ProviderModel",
    "ProviderRecord",
    "ProviderState",
    "ResolvedProvider",
    "RuntimeModel",
]
