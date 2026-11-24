from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from iclip.platform.runtime_api.agent_usage import AgentUsageOut
from iclip.platform.runtime_api.config.model_providers.models import (
    CredentialFieldType,
    ModelSource,
    ModelType,
)
from iclip.platform.runtime_api.model_vocab import (
    MODEL_GROUP_PATTERN,
    ModelApi,
    NativeToolName,
    ThinkingEffort,
)

ModelGroupField = Annotated[str, Field(pattern=MODEL_GROUP_PATTERN)]


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=True
    )


class CredentialFieldOut(CamelModel):
    """密钥表单的一个字段。``secret`` 的值只会以打码形式返回。"""

    name: str
    label: str
    type: CredentialFieldType
    required: bool
    default: str | None


class NativeToolOut(CamelModel):
    """一个原生工具：名字、显示名，以及开它之前必须先开的。"""

    name: NativeToolName
    label: str
    requires: list[NativeToolName]


class DeclaredModelOut(CamelModel):
    name: str
    type: ModelType
    api: ModelApi | None
    context_size: int | None
    thinking: list[ThinkingEffort]
    native_tools: list[NativeToolName]


class DeclarationOut(CamelModel):
    """一家可以接入的供应商。"""

    name: str
    label: str
    apis: list[ModelApi]
    credential_fields: list[CredentialFieldOut]
    custom_models: bool
    models: list[DeclaredModelOut]
    native_tools_by_api: dict[ModelApi, list[NativeToolName]]


class DeclarationsOut(CamelModel):
    declarations: list[DeclarationOut]
    native_tools: list[NativeToolOut]


class ProviderModelOut(DeclaredModelOut):
    """供应商的一个模型：声明里的叠加停用设置，或自己加的。"""

    source: ModelSource
    enabled: bool
    used_by: list[AgentUsageOut]


class CredentialOut(CamelModel):
    """``modelGroup`` 是这把密钥归的配置组，为空即不归任何组。"""

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
    """不给或给 ``null`` 的项不动。"""

    label: str | None = None
    enabled: bool | None = None
    default_credential_id: uuid.UUID | None = None


class CredentialCreateIn(CamelModel):
    """``modelGroup`` 给了就把这把密钥归进这个配置组；同一供应商下一个组最多一把。"""

    name: str
    fields: dict[str, str]
    model_group: ModelGroupField | None = None


class CredentialUpdateIn(CamelModel):
    """``name`` 与 ``fields`` 不给或给 ``null`` 都不动；``modelGroup`` 不给不动，给 ``null`` 清掉，给值改成
    这个组。"""

    name: str | None = None
    fields: dict[str, str] | None = None
    model_group: ModelGroupField | None = None


class CredentialTestIn(CamelModel):
    """``credentialId`` 与 ``fields`` 至少给一个：只给 ``credentialId`` 试已保存的那一把；只给
    ``fields`` 试一组还没保存的字段（规则同新建）；两个都给就是把 ``fields`` 叠到已保存的那一把上再试
    （规则同修改）。"""

    credential_id: uuid.UUID | None = None
    fields: dict[str, str] | None = None


class ModelTestIn(CamelModel):
    """测试供应商的一个模型：用 ``credentialId`` 那把密钥，不给就用供应商的默认密钥。"""

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
    native_tools: list[NativeToolName] = []


class ModelUpdateIn(CamelModel):
    """不给的项不动。``enabled`` 声明里的模型与自己加的都能改；其余三项只有自己加的模型能改，
    ``contextSize`` 给 ``null`` 即清掉。"""

    enabled: bool | None = None
    api: ModelApi | None = None
    context_size: int | None = None
    thinking: list[ThinkingEffort] | None = None
    native_tools: list[NativeToolName] | None = None


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
    """agent 能选的一个对话模型。"""

    name: str
    context_size: int | None
    thinking: list[ThinkingEffort]
    native_tools: list[NativeToolName]


class CredentialOptionOut(CamelModel):
    """agent 能选的一把密钥。"""

    id: uuid.UUID
    name: str
    fields: dict[str, str]
    is_default: bool


class ProviderOptionOut(CamelModel):
    """agent 能选的一个供应商。"""

    id: uuid.UUID
    name: str
    label: str
    models: list[ModelOptionOut]
    credentials: list[CredentialOptionOut]


class ModelOptionsOut(CamelModel):
    """agent 编辑页选模型用：只读，只列启用的供应商。"""

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
