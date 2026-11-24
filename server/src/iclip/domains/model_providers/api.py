from __future__ import annotations

import uuid
from collections.abc import Sequence
from typing import Annotated

from fastapi import APIRouter, Response
from pydantic import BaseModel

from iclip.common.errors import ValidationFailed
from iclip.domains.identity.public import Principal, require_permission
from iclip.platform.runtime_admin import admin_path, relay
from iclip.platform.runtime_api.client import RuntimeClient
from iclip.platform.runtime_api.config.model_providers.models import ModelType
from iclip.platform.runtime_api.config.model_providers.schemas import (
    CredentialCreateIn,
    CredentialOut,
    CredentialTestIn,
    CredentialUpdateIn,
    CustomModelCreateIn,
    DeclarationsOut,
    DefaultModelIn,
    DefaultModelOut,
    DefaultModelsOut,
    ModelProviderCreateIn,
    ModelProviderOut,
    ModelProvidersOut,
    ModelProviderUpdateIn,
    ModelTestIn,
    ModelUpdateIn,
    ProbeOut,
    ProviderModelOut,
)

_MANAGE = "model:manage"


class ModelGroupsOut(BaseModel):
    """``config.yaml`` 中可分配的配置组名列表（不含保留组 ``default``），按配置顺序排列；未配置时为空列表。"""

    groups: list[str]


def create_model_providers_router(
    runtime: RuntimeClient, *, model_groups: Sequence[str]
) -> APIRouter:
    """``model_groups`` 为部署配置中可分配的配置组名（不含保留组 ``default``，按配置顺序排列），密钥仅可归属其中的组。"""

    router = APIRouter(prefix="/model-providers", tags=["model-providers"])
    configured = tuple(model_groups)

    def check_group(group: str | None) -> None:
        if group is not None and group not in configured:
            choices = "、".join(configured) or "无"
            raise ValidationFailed(
                f"配置组 {group} 不在部署配置的 model_groups 中，可选配置组：{choices}"
            )

    @router.get("/groups", response_model=ModelGroupsOut)
    async def model_groups_configured(
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> ModelGroupsOut:
        """返回部署配置中可分配的配置组名列表（不含保留组 ``default``，按配置顺序排列）；密钥可归属其中任意一组，未归组时归属默认组。"""

        return ModelGroupsOut(groups=list(configured))

    @router.get("/declarations", response_model=DeclarationsOut)
    async def model_provider_declarations(
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """列出可接入的模型供应商声明（显示名、接口协议、密钥字段及各接口支持的原生工具）与原生工具名录。"""

        return await relay(runtime, "GET", "model-providers/declarations", actor=principal.user_id)

    @router.get("", response_model=ModelProvidersOut)
    async def model_providers(
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """列出已接入的全部模型供应商，包含脱敏密钥、默认密钥与模型列表。"""

        return await relay(runtime, "GET", "model-providers", actor=principal.user_id)

    @router.post("", response_model=ModelProviderOut, status_code=201)
    async def create_model_provider(
        body: ModelProviderCreateIn,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """按供应商声明接入新供应商（默认启用，初始不含密钥与模型）。"""

        return await relay(runtime, "POST", "model-providers", actor=principal.user_id, body=body)

    @router.patch("/{provider_id}", response_model=ModelProviderOut)
    async def update_model_provider(
        provider_id: uuid.UUID,
        body: ModelProviderUpdateIn,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """修改供应商的显示名、启停状态或默认密钥。"""

        return await relay(
            runtime,
            "PATCH",
            admin_path("model-providers", str(provider_id)),
            actor=principal.user_id,
            body=body,
        )

    @router.delete("/{provider_id}", status_code=204)
    async def delete_model_provider(
        provider_id: uuid.UUID,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """删除供应商及其全部密钥与模型；仍被 Agent 草稿或当前版本引用或包含默认模型时返回 409。"""

        return await relay(
            runtime,
            "DELETE",
            admin_path("model-providers", str(provider_id)),
            actor=principal.user_id,
        )

    @router.post("/{provider_id}/credentials", response_model=CredentialOut, status_code=201)
    async def create_provider_credential(
        provider_id: uuid.UUID,
        body: CredentialCreateIn,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """新增密钥（不强制联网测试）；供应商的首把密钥自动设为默认密钥。传入 ``modelGroup`` 时归属至对应配置组，
        不在部署配置中返回 422。"""

        check_group(body.model_group)
        return await relay(
            runtime,
            "POST",
            admin_path("model-providers", str(provider_id), "credentials"),
            actor=principal.user_id,
            body=body,
        )

    @router.post("/{provider_id}/credentials/test", response_model=ProbeOut)
    async def test_provider_credential(
        provider_id: uuid.UUID,
        body: CredentialTestIn,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """测试密钥连通性（不落库）；无论通过与否均返回 200，以响应体 ``ok`` 字段为准。"""

        return await relay(
            runtime,
            "POST",
            admin_path("model-providers", str(provider_id), "credentials/test"),
            actor=principal.user_id,
            body=body,
        )

    @router.patch("/{provider_id}/credentials/{credential_id}", response_model=CredentialOut)
    async def update_provider_credential(
        provider_id: uuid.UUID,
        credential_id: uuid.UUID,
        body: CredentialUpdateIn,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """修改密钥名称、字段或配置组（不联网测试）。``modelGroup`` 未传入保持不变，传入 ``null`` 清空归组，
        传入组名则更新归组；组不在部署配置中返回 422。"""

        check_group(body.model_group)
        return await relay(
            runtime,
            "PATCH",
            admin_path("model-providers", str(provider_id), "credentials", str(credential_id)),
            actor=principal.user_id,
            body=body,
        )

    @router.delete("/{provider_id}/credentials/{credential_id}", status_code=204)
    async def delete_provider_credential(
        provider_id: uuid.UUID,
        credential_id: uuid.UUID,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """删除指定密钥；默认密钥须先切换默认后方可删除。"""

        return await relay(
            runtime,
            "DELETE",
            admin_path("model-providers", str(provider_id), "credentials", str(credential_id)),
            actor=principal.user_id,
        )

    @router.post("/{provider_id}/models", response_model=ProviderModelOut, status_code=201)
    async def add_provider_model(
        provider_id: uuid.UUID,
        body: CustomModelCreateIn,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """为供应商添加模型，添加后默认启用。"""

        return await relay(
            runtime,
            "POST",
            admin_path("model-providers", str(provider_id), "models"),
            actor=principal.user_id,
            body=body,
        )

    @router.post("/{provider_id}/models/test", response_model=ProbeOut)
    async def test_provider_model(
        provider_id: uuid.UUID,
        body: ModelTestIn,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """使用指定密钥（缺省时用默认密钥）测试单个 ``llm`` 模型连通性（不落库）；失败亦返回 200。"""

        return await relay(
            runtime,
            "POST",
            admin_path("model-providers", str(provider_id), "models/test"),
            actor=principal.user_id,
            body=body,
        )

    @router.patch(
        "/{provider_id}/models/{model_type}/{model_name:path}", response_model=ProviderModelOut
    )
    async def update_provider_model(
        provider_id: uuid.UUID,
        model_type: ModelType,
        model_name: str,
        body: ModelUpdateIn,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """启停模型或修改其属性。模型名置于路径末尾，支持包含斜杠。"""

        return await relay(
            runtime,
            "PATCH",
            admin_path("model-providers", str(provider_id), "models", model_type, model_name),
            actor=principal.user_id,
            body=body,
        )

    @router.delete("/{provider_id}/models/{model_type}/{model_name:path}", status_code=204)
    async def delete_provider_model(
        provider_id: uuid.UUID,
        model_type: ModelType,
        model_name: str,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """删除模型；正被 Agent 引用或已设为默认模型时返回 409。"""

        return await relay(
            runtime,
            "DELETE",
            admin_path("model-providers", str(provider_id), "models", model_type, model_name),
            actor=principal.user_id,
        )

    return router


def create_default_models_router(runtime: RuntimeClient) -> APIRouter:
    router = APIRouter(prefix="/default-models", tags=["model-providers"])

    @router.get("", response_model=DefaultModelsOut)
    async def default_models(
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """查询各模型类型的全局默认模型。"""

        return await relay(runtime, "GET", "default-models", actor=principal.user_id)

    @router.put("/{model_type}", response_model=DefaultModelOut)
    async def set_default_model(
        model_type: ModelType,
        body: DefaultModelIn,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """将指定模型类型的全局默认模型设为某供应商下已启用的模型。"""

        return await relay(
            runtime,
            "PUT",
            admin_path("default-models", model_type),
            actor=principal.user_id,
            body=body,
        )

    return router


__all__ = ["ModelGroupsOut", "create_default_models_router", "create_model_providers_router"]
