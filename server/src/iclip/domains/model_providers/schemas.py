"""模型供应商端点的请求与响应形状，camelCase 别名。术语见 docs/CONTEXT.md「供应商」等词条。"""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from iclip.common.agent_usage import AgentUsageOut
from iclip.common.model_vocab import ModelApi, ThinkingEffort
from iclip.domains.model_providers.models import CredentialFieldType, ModelSource, ModelType


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
    """不填时用的值；机密字段恒为 ``null``。"""


class DeclaredModelOut(CamelModel):
    name: str
    type: ModelType
    api: ModelApi | None
    """只有 llm 有。"""
    context_size: int | None
    thinking: list[ThinkingEffort]
    """允许设的思考档位；空就是不能设档位。"""


class DeclarationOut(CamelModel):
    """一家可以接入的供应商。"""

    name: str
    """声明名，接入时填进 ``provider``。"""
    label: str
    credential_fields: list[CredentialFieldOut]
    custom_models: bool
    """能不能自己加模型。"""
    models: list[DeclaredModelOut]


class DeclarationsOut(CamelModel):
    declarations: list[DeclarationOut]


class ProviderModelOut(DeclaredModelOut):
    """供应商的一个模型：声明里的叠加停用设置，或自己加的。"""

    source: ModelSource
    enabled: bool
    used_by: list[AgentUsageOut]
    """草稿或当前版本写着这个模型的 agent，按 agent 标识排；它们还在用时不能停用或删除。只有 llm 会有。"""


class CredentialOut(CamelModel):
    id: uuid.UUID
    name: str
    fields: dict[str, str]
    """按声明的字段名给值；机密字段是打码后的样子（``••••`` 加末 4 位，原值不足 8 位只有 ``••••``）。"""
    used_by: list[AgentUsageOut]
    """草稿或当前版本显式写着这把密钥的 agent，按 agent 标识排；它们还在用时不能删。"""
    created_at: datetime
    updated_at: datetime


class ModelProviderOut(CamelModel):
    id: uuid.UUID
    name: str
    """引用名，接入后不能改。"""
    provider: str
    """用的声明名。"""
    label: str
    enabled: bool
    default_credential_id: uuid.UUID | None
    """还没有密钥时为 ``null``。"""
    credentials: list[CredentialOut]
    """新的在前。"""
    models: list[ProviderModelOut]
    """声明里的按声明顺序在前，自己加的按类型、名字在后。"""
    created_at: datetime
    updated_at: datetime


class ModelProvidersOut(CamelModel):
    providers: list[ModelProviderOut]
    """按接入时刻从新到旧。"""


class ModelProviderCreateIn(CamelModel):
    name: str
    """引用名：小写字母、数字、连字符，最多 64 个字符，接入后不能改。"""
    provider: str
    """声明名，见 ``GET /model-providers/declarations``。"""
    label: str


class ModelProviderUpdateIn(CamelModel):
    """不给或给 ``null`` 的项不动。"""

    label: str | None = None
    enabled: bool | None = None
    default_credential_id: uuid.UUID | None = None
    """换默认密钥，必须是这个供应商的密钥。"""


class CredentialCreateIn(CamelModel):
    name: str
    fields: dict[str, str]
    """按声明的字段名给值；没给的字段用声明里的 ``default``。"""


class CredentialUpdateIn(CamelModel):
    """不给或给 ``null`` 的项不动。"""

    name: str | None = None
    fields: dict[str, str] | None = None
    """只放要改的字段，给了就替换；没给的字段（包括机密字段）保持原值。"""


class CredentialTestIn(CamelModel):
    """``credentialId`` 与 ``fields`` 至少给一个：只给 ``credentialId`` 试已保存的那一把；只给
    ``fields`` 试一组还没保存的字段（规则同新建）；两个都给就是把 ``fields`` 叠到已保存的那一把上再试
    （规则同修改）。"""

    credential_id: uuid.UUID | None = None
    fields: dict[str, str] | None = None


class ProbeOut(CamelModel):
    ok: bool
    elapsed_ms: int
    reason: str | None
    """失败原因，给人看的一句话；成功时为 ``null``。"""


class CustomModelCreateIn(CamelModel):
    name: str
    type: ModelType
    api: ModelApi | None = None
    """llm 必填，其余类型不能给。"""
    context_size: int | None = None
    thinking: list[ThinkingEffort] = []
    """只有 llm 能给。"""


class ModelUpdateIn(CamelModel):
    """不给的项不动。``enabled`` 声明里的模型与自己加的都能改；其余三项只有自己加的模型能改，
    ``contextSize`` 给 ``null`` 即清掉。"""

    enabled: bool | None = None
    api: ModelApi | None = None
    context_size: int | None = None
    thinking: list[ThinkingEffort] | None = None


class DefaultModelOut(CamelModel):
    type: ModelType
    provider_id: uuid.UUID
    provider_name: str
    model_name: str
    updated_at: datetime


class DefaultModelsOut(CamelModel):
    defaults: list[DefaultModelOut]
    """设过的类型各一条，按类型排；没设过的类型不在里面。"""


class DefaultModelIn(CamelModel):
    provider_id: uuid.UUID
    model_name: str


__all__ = [
    "CredentialCreateIn",
    "CredentialFieldOut",
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
    "ModelProviderCreateIn",
    "ModelProviderOut",
    "ModelProviderUpdateIn",
    "ModelProvidersOut",
    "ModelUpdateIn",
    "ProbeOut",
    "ProviderModelOut",
]
