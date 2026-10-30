"""模型供应商 HTTP 端点，约定见合同「模型供应商」一节。全部要求 ``model:manage``。"""

from __future__ import annotations

import uuid
from typing import Annotated

from agent_runtime.config.model_providers.models import ModelType
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
    ModelProviderCreateIn,
    ModelProviderOut,
    ModelProvidersOut,
    ModelProviderUpdateIn,
    ModelUpdateIn,
    ProbeOut,
    ProviderModelOut,
)
from agent_runtime.config.model_providers.service import ModelProviderService
from fastapi import APIRouter, Response

from iclip.domains.identity.public import Principal, require_permission

_MANAGE = "model:manage"


def create_model_providers_router(service: ModelProviderService) -> APIRouter:
    router = APIRouter(prefix="/model-providers", tags=["model-providers"])

    @router.get("/declarations", response_model=DeclarationsOut)
    async def model_provider_declarations(
        _: Annotated[Principal, require_permission(_MANAGE)],
    ) -> DeclarationsOut:
        """可以接入的供应商声明：显示名、密钥表单字段、能不能自己加模型、内置的模型。"""

        return service.declarations()

    @router.get("", response_model=ModelProvidersOut)
    async def model_providers(
        _: Annotated[Principal, require_permission(_MANAGE)],
    ) -> ModelProvidersOut:
        """接入的全部供应商，带打码的密钥、默认密钥与合并后的模型列表。"""

        return await service.providers()

    @router.post("", response_model=ModelProviderOut, status_code=201)
    async def create_model_provider(
        body: ModelProviderCreateIn,
        _: Annotated[Principal, require_permission(_MANAGE)],
    ) -> ModelProviderOut:
        """按一份声明接入一个供应商，启用、还没有密钥。"""

        return await service.create(body)

    @router.patch("/{provider_id}", response_model=ModelProviderOut)
    async def update_model_provider(
        provider_id: uuid.UUID,
        body: ModelProviderUpdateIn,
        _: Annotated[Principal, require_permission(_MANAGE)],
    ) -> ModelProviderOut:
        """改显示名、启停或默认密钥。"""

        return await service.update(provider_id, body)

    @router.post("/{provider_id}/credentials", response_model=CredentialOut, status_code=201)
    async def create_provider_credential(
        provider_id: uuid.UUID,
        body: CredentialCreateIn,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> CredentialOut:
        """新建一把密钥：先试连，通过才保存；供应商的第一把成为默认密钥。"""

        return await service.create_credential(provider_id, body, created_by=principal.user_id)

    @router.post("/{provider_id}/credentials/test", response_model=ProbeOut)
    async def test_provider_credential(
        provider_id: uuid.UUID,
        body: CredentialTestIn,
        _: Annotated[Principal, require_permission(_MANAGE)],
    ) -> ProbeOut:
        """试连，不保存；结果在答复里，没通过也是 200。"""

        return await service.test_credential(provider_id, body)

    @router.patch("/{provider_id}/credentials/{credential_id}", response_model=CredentialOut)
    async def update_provider_credential(
        provider_id: uuid.UUID,
        credential_id: uuid.UUID,
        body: CredentialUpdateIn,
        _: Annotated[Principal, require_permission(_MANAGE)],
    ) -> CredentialOut:
        """改名或改字段；字段有变化时先试连，通过才保存。"""

        return await service.update_credential(provider_id, credential_id, body)

    @router.delete("/{provider_id}/credentials/{credential_id}", status_code=204)
    async def delete_provider_credential(
        provider_id: uuid.UUID,
        credential_id: uuid.UUID,
        _: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """删一把密钥；默认密钥不能删。"""

        await service.delete_credential(provider_id, credential_id)
        return Response(status_code=204)

    @router.post("/{provider_id}/models", response_model=ProviderModelOut, status_code=201)
    async def add_provider_model(
        provider_id: uuid.UUID,
        body: CustomModelCreateIn,
        _: Annotated[Principal, require_permission(_MANAGE)],
    ) -> ProviderModelOut:
        """自己加一个模型；声明允许自己加模型时才能加。"""

        return await service.add_model(provider_id, body)

    @router.patch(
        "/{provider_id}/models/{model_type}/{model_name:path}", response_model=ProviderModelOut
    )
    async def update_provider_model(
        provider_id: uuid.UUID,
        model_type: ModelType,
        model_name: str,
        body: ModelUpdateIn,
        _: Annotated[Principal, require_permission(_MANAGE)],
    ) -> ProviderModelOut:
        """启停一个模型，或改自己加的模型的属性。模型名放在路径最后，可以带斜杠。"""

        return await service.update_model(provider_id, model_type, model_name, body)

    @router.delete("/{provider_id}/models/{model_type}/{model_name:path}", status_code=204)
    async def delete_provider_model(
        provider_id: uuid.UUID,
        model_type: ModelType,
        model_name: str,
        _: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """删一个自己加的模型；声明里的模型只能停用。"""

        await service.delete_model(provider_id, model_type, model_name)
        return Response(status_code=204)

    return router


def create_default_models_router(service: ModelProviderService) -> APIRouter:
    router = APIRouter(prefix="/default-models", tags=["model-providers"])

    @router.get("", response_model=DefaultModelsOut)
    async def default_models(
        _: Annotated[Principal, require_permission(_MANAGE)],
    ) -> DefaultModelsOut:
        """各类型的默认模型。"""

        return await service.default_models()

    @router.put("/{model_type}", response_model=DefaultModelOut)
    async def set_default_model(
        model_type: ModelType,
        body: DefaultModelIn,
        _: Annotated[Principal, require_permission(_MANAGE)],
    ) -> DefaultModelOut:
        """把这个类型的默认模型设成某供应商一个已启用的模型。"""

        return await service.set_default_model(model_type, body)

    return router


__all__ = ["create_default_models_router", "create_model_providers_router"]
