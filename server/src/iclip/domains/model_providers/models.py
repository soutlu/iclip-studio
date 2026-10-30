"""模型供应商的领域形状：表里的行、合并后的模型、试连结果与机密字段的打码。

术语见 docs/CONTEXT.md「供应商」「密钥」「模型声明」「默认模型」。"""

from __future__ import annotations

import re
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Final, Literal

from iclip.common.model_vocab import ModelApi, ThinkingEffort

ModelType = Literal["llm", "embedding", "rerank"]

ModelSource = Literal["declared", "custom"]
"""``declared`` 是供应商声明里的模型；``custom`` 是接入后自己加的模型。"""

SOURCE_DECLARED: Final = "declared"
SOURCE_CUSTOM: Final = "custom"

CredentialFieldType = Literal["secret", "text"]
"""``secret`` 存密文、返回时打码；``text`` 存明文、原样返回。"""

FIELD_SECRET: Final = "secret"

PROVIDER_NAME_PATTERN: Final = re.compile(r"^[a-z0-9-]{1,64}$")
"""供应商引用名：小写字母、数字、连字符，接入后不能改。"""

MAX_LABEL_CHARS: Final = 50
MAX_CREDENTIAL_NAME_CHARS: Final = 50
MAX_MODEL_NAME_CHARS: Final = 200
MAX_FIELD_VALUE_CHARS: Final = 2000

MASK: Final = "••••"
MASK_MIN_CHARS: Final = 8
"""原值不足这么多位时只给 ``MASK``，不露末 4 位。"""


def mask_secret(value: str) -> str:
    """机密字段返回给人看的样子：``••••`` 加末 4 位；原值不足 8 位只给 ``••••``。"""

    if len(value) < MASK_MIN_CHARS:
        return MASK
    return MASK + value[-4:]


@dataclass(frozen=True, slots=True)
class ModelProperties:
    """一个模型的属性。``api`` 只有 llm 有；``thinking`` 是允许设的思考档位，空就是不能设档位。"""

    api: ModelApi | None
    context_size: int | None
    thinking: tuple[ThinkingEffort, ...]


@dataclass(frozen=True, slots=True)
class ProviderModel:
    """供应商的一个模型，声明里的与自己加的合并之后的样子；同一供应商内按（名字，类型）认。"""

    name: str
    type: ModelType
    source: ModelSource
    properties: ModelProperties
    enabled: bool


@dataclass(frozen=True, slots=True)
class ProviderRecord:
    """``model_providers`` 的一行：一个接入的供应商。``provider`` 是它用的声明名。"""

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
    """``provider_credentials`` 的一行。``fields`` 是存储形态：机密字段是密文，其余是明文。"""

    id: uuid.UUID
    provider_id: uuid.UUID
    name: str
    fields: Mapping[str, str]
    created_by: uuid.UUID
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class ModelSetting:
    """``provider_models`` 的一行。声明里的模型只在停用时有一行（``enabled`` 为假、没有属性）；
    自己加的模型一个一行，带完整属性。"""

    name: str
    type: ModelType
    source: ModelSource
    properties: ModelProperties | None
    enabled: bool


@dataclass(frozen=True, slots=True)
class DefaultModel:
    """``default_models`` 的一行：某类型的默认模型，按「供应商 + 模型名」引用。``provider_name`` 是那个
    供应商的引用名，读的时候连带取出。"""

    type: ModelType
    provider_id: uuid.UUID
    provider_name: str
    model_name: str
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class ProviderState:
    """一个供应商此刻的全部：那一行、它的密钥（新的在前）与它在 ``provider_models`` 里的行。"""

    provider: ProviderRecord
    credentials: tuple[CredentialRecord, ...]
    settings: tuple[ModelSetting, ...]


@dataclass(frozen=True, slots=True)
class ResolvedProvider:
    """给别的模块看的一个供应商：那一行、全部密钥的 id 与合并后的模型列表。"""

    provider: ProviderRecord
    credential_ids: tuple[uuid.UUID, ...]
    models: tuple[ProviderModel, ...]


@dataclass(frozen=True, slots=True)
class ProbeResult:
    """一次试连的结果。``reason`` 只在失败时有，不带密钥，也不带完整请求。"""

    ok: bool
    elapsed_ms: int
    reason: str | None = None


__all__ = [
    "FIELD_SECRET",
    "MASK",
    "MASK_MIN_CHARS",
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
    "mask_secret",
]
