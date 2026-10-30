"""模型供应商的端口：自有四张表的仓储，以及由组合根接上的试连与「谁在用」。"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Mapping
from contextlib import AbstractAsyncContextManager
from typing import Protocol

from iclip.common.agent_usage import ModelReference
from iclip.domains.model_providers.catalog import ProviderDeclaration
from iclip.domains.model_providers.models import (
    CredentialRecord,
    DefaultModel,
    ModelSetting,
    ModelType,
    ProbeResult,
    ProviderModel,
    ProviderState,
)


class ProviderEditor(Protocol):
    """一次改一个供应商：开始时锁住它那一行，块正常结束提交、出错回滚。它的密钥、默认密钥、模型设置
    与指向它的默认模型都只在这里改，所以「默认密钥不能删」「默认模型必须已启用」这类跨行的规则在锁里
    读、在锁里写，不会被并发的另一次修改绕过。同一供应商内密钥撞名在这里就是 ``ValidationFailed``。"""

    @property
    def state(self) -> ProviderState:
        """拿到锁之后读到的这个供应商。"""
        ...

    @property
    def defaults(self) -> tuple[DefaultModel, ...]:
        """拿到锁之后读到的、指向这个供应商的默认模型。"""
        ...

    async def update_provider(
        self, *, label: str, enabled: bool, default_credential_id: uuid.UUID | None
    ) -> None:
        """三项都按给的写，并更新 ``updated_at``。"""
        ...

    async def insert_credential(
        self,
        credential_id: uuid.UUID,
        *,
        name: str,
        fields: Mapping[str, str],
        created_by: uuid.UUID,
    ) -> None:
        """``fields`` 是存储形态。供应商还没有默认密钥时，这一把成为默认。"""
        ...

    async def update_credential(
        self, credential_id: uuid.UUID, *, name: str, fields: Mapping[str, str]
    ) -> None:
        """两项都按给的写，``fields`` 是存储形态。"""
        ...

    async def delete_credential(self, credential_id: uuid.UUID) -> None: ...

    async def put_model(self, setting: ModelSetting) -> None:
        """按（名字，类型）写一行，有就整行替换。"""
        ...

    async def delete_model(self, name: str, model_type: ModelType) -> None:
        """删掉（名字，类型）那一行；没有不报错。"""
        ...

    async def set_default_model(self, model_type: ModelType, model_name: str) -> None:
        """这个类型的默认模型改成本供应商的 ``model_name``，没有就建。"""
        ...


class ModelProviderStore(Protocol):
    """``model_providers``、``provider_credentials``、``provider_models``、``default_models`` 的数据访问。"""

    async def states(self) -> tuple[ProviderState, ...]:
        """全部供应商，按接入时刻从新到旧、同一时刻按 id 倒序。"""
        ...

    async def state(self, provider_id: uuid.UUID) -> ProviderState | None: ...

    async def insert_provider(
        self, provider_id: uuid.UUID, *, name: str, provider: str, label: str
    ) -> None:
        """接入一个供应商，启用、没有密钥。``name`` 撞了是 ``ValidationFailed``。"""
        ...

    def edit(self, provider_id: uuid.UUID) -> AbstractAsyncContextManager[ProviderEditor]:
        """开一次修改，见 ``ProviderEditor``；没有这个供应商是 ``NotFound``。"""
        ...

    async def default_models(self) -> tuple[DefaultModel, ...]:
        """全部默认模型，按类型排。"""
        ...

    async def rewrite_credentials(
        self, rewrite: Callable[[str, CredentialRecord], Mapping[str, str]]
    ) -> int:
        """在一个事务里锁住全部密钥，逐把用 ``rewrite(声明名, 密钥)`` 算出新的存储形态写回；交回改了几把。"""
        ...


class CredentialProbe(Protocol):
    """用一组密钥字段试连：按声明建出 ``model`` 发一个最小的请求。每次都是一次真实的上游调用。"""

    async def probe(
        self, declaration: ProviderDeclaration, model: ProviderModel, fields: Mapping[str, str]
    ) -> ProbeResult:
        """``fields`` 是明文。连不上、被拒、超时都放进结果，不抛；结果里不带密钥与完整请求。"""
        ...


class ModelUsages(Protocol):
    """哪些 agent 在用哪个模型，由组合根接到 agent 配置域：草稿或当前版本里写的才算。"""

    async def model_references(self) -> tuple[ModelReference, ...]:
        """每个 agent 的草稿与当前版本里写的模型，各一条。"""
        ...


__all__ = ["CredentialProbe", "ModelProviderStore", "ModelUsages", "ProviderEditor"]
