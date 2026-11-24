from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from iclip.platform.runtime_api.agent_usage import AgentUsageOut
from iclip.platform.runtime_api.config.model_providers.models import (
    CredentialFieldType,
    ModelType,
)
from iclip.platform.runtime_api.model_vocab import (
    MODEL_GROUP_PATTERN,
    ModelApi,
    ThinkingEffort,
)

ModelGroupField = Annotated[str, Field(pattern=MODEL_GROUP_PATTERN)]


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True
    )


class NativeToolOut(CamelModel):
    """原生工具定义：接口类型名、显示名及其前置依赖列表。"""

    name: str
    label: str
    requires: list[str]


class CredentialFieldOut(CamelModel):
    """密钥表单字段定义。``secret`` 类型字段仅以打码形式返回。"""

    name: str
    label: str
    type: CredentialFieldType
    required: bool
    default: str | None


class DeclaredModelOut(CamelModel):
    name: str
    type: ModelType
    api: ModelApi | None
    context_size: int | None
    thinking: list[ThinkingEffort]
    native_tools: list[str]


class DeclarationOut(CamelModel):
    """可接入的模型供应商声明。``nativeToolsByApi`` 按接口协议列出允许配置的原生工具名。"""

    name: str
    label: str
    apis: list[ModelApi]
    credential_fields: list[CredentialFieldOut]
    native_tools_by_api: dict[ModelApi, list[str]]


class DeclarationsOut(CamelModel):
    """可接入供应商声明及全部原生工具名录（``nativeTools``）。"""

    declarations: list[DeclarationOut]
    native_tools: list[NativeToolOut]


class ProviderModelOut(DeclaredModelOut):
    """供应商下的单个模型配置。"""

    enabled: bool
    used_by: list[AgentUsageOut]


class CredentialOut(CamelModel):
    """供应商密钥。``modelGroup`` 为归属配置组，为空表示不归属任何组。"""

    id: uuid.UUID
    name: str
    fields: dict[str, str]
    model_group: str | None
    used_by: list[AgentUsageOut]
    created_at: datetime
    updated_at: datetime


class ModelProviderOut(CamelModel):
    id: uuid.UUID
    name: str
    provider: str
    label: str
    enabled: bool
    default_credential_id: uuid.UUID | None
    credentials: list[CredentialOut]
    models: list[ProviderModelOut]
    created_at: datetime
    updated_at: datetime


class ModelProvidersOut(CamelModel):
    providers: list[ModelProviderOut]


class ModelProviderCreateIn(CamelModel):
    name: str
    provider: str
    label: str


class ModelProviderUpdateIn(CamelModel):
    """未传入或传入 ``null`` 的字段保持不变。"""

    label: str | None = None
    enabled: bool | None = None
    default_credential_id: uuid.UUID | None = None


class CredentialCreateIn(CamelModel):
    """传入 ``modelGroup`` 时将该密钥绑定至对应配置组；同一供应商下每个配置组最多绑定一把密钥。"""

    name: str
    fields: dict[str, str]
    model_group: ModelGroupField | None = None


class CredentialUpdateIn(CamelModel):
    """``name`` 与 ``fields`` 未传入或传入 ``null`` 时保持不变；``modelGroup`` 未传入保持不变，传入 ``null``
    清空归组，传入组名则更新归组。"""

    name: str | None = None
    fields: dict[str, str] | None = None
    model_group: ModelGroupField | None = None


class CredentialTestIn(CamelModel):
    """``credentialId`` 与 ``fields`` 至少传入其一：仅传 ``credentialId`` 测试已保存密钥；仅传 ``fields``
    按新建规则测试未保存字段；两者同传则将 ``fields`` 按更新规则覆盖至已保存密钥后测试。"""

    credential_id: uuid.UUID | None = None
    fields: dict[str, str] | None = None


class ModelTestIn(CamelModel):
    """测试供应商下的指定模型；未传 ``credentialId`` 时使用该供应商的默认密钥。"""

    name: str
    type: ModelType
    credential_id: uuid.UUID | None = None


class ProbeOut(CamelModel):
    ok: bool
    elapsed_ms: int
    reason: str | None


class CustomModelCreateIn(CamelModel):
    name: str
    type: ModelType
    api: ModelApi | None = None
    context_size: int | None = None
    thinking: list[ThinkingEffort] = []
    native_tools: list[str] = []


class ModelUpdateIn(CamelModel):
    """未传入的字段保持不变；``contextSize`` 传入 ``null`` 表示清空上下文窗口配置。"""

    enabled: bool | None = None
    api: ModelApi | None = None
    context_size: int | None = None
    thinking: list[ThinkingEffort] | None = None
    native_tools: list[str] | None = None


class DefaultModelOut(CamelModel):
    type: ModelType
    provider_id: uuid.UUID
    provider_name: str
    model_name: str
    updated_at: datetime


class DefaultModelsOut(CamelModel):
    defaults: list[DefaultModelOut]


class DefaultModelIn(CamelModel):
    provider_id: uuid.UUID
    model_name: str


class ModelOptionOut(CamelModel):
    """Agent 可选的单个对话模型。"""

    name: str
    context_size: int | None
    thinking: list[ThinkingEffort]
    native_tools: list[str]


class CredentialOptionOut(CamelModel):
    """Agent 可选的单把密钥。"""

    id: uuid.UUID
    name: str
    fields: dict[str, str]
    is_default: bool


class ProviderOptionOut(CamelModel):
    """Agent 可选的单个供应商。"""

    id: uuid.UUID
    name: str
    label: str
    models: list[ModelOptionOut]
    credentials: list[CredentialOptionOut]


class ModelOptionsOut(CamelModel):
    """Agent 编辑页的模型可选项（只读，仅含已启用供应商），附带全部原生工具名录（``nativeTools``）。"""

    providers: list[ProviderOptionOut]
    native_tools: list[NativeToolOut]


__all__ = [
    "CredentialCreateIn",
    "CredentialFieldOut",
    "CredentialOptionOut",
    "CredentialOut",
    "CredentialTestIn",
    "CredentialUpdateIn",
    "CustomModelCreateIn",
    "DeclarationOut",
    "DeclarationsOut",
    "DeclaredModelOut",
    "DefaultModelIn",
    "DefaultModelOut",
    "DefaultModelsOut",
    "ModelGroupField",
    "ModelOptionOut",
    "ModelOptionsOut",
    "ModelProviderCreateIn",
    "ModelProviderOut",
    "ModelProviderUpdateIn",
    "ModelProvidersOut",
    "ModelTestIn",
    "ModelUpdateIn",
    "NativeToolOut",
    "ProbeOut",
    "ProviderModelOut",
    "ProviderOptionOut",
]
