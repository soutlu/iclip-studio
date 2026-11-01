"""模型供应商 HTTP 端点，约定见合同「模型供应商」一节。全部要求 ``model:manage``。

业务在运行时服务：每个端点验完权限与请求体，按同一个子路径转给它的 ``/v1/admin/model-providers`` 与
``/v1/admin/default-models``，答复原样交回（见 ``iclip.platform.runtime_admin``）。请求与答复的声明照旧写在
这里，合同由它们导出。
"""

from __future__ import annotations

import uuid
from typing import Annotated

from agent_runtime.client import RuntimeClient
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
from fastapi import APIRouter, Response

from iclip.domains.identity.public import Principal, require_permission
from iclip.platform.runtime_admin import admin_path, relay

_MANAGE = "model:manage"


def create_model_providers_router(runtime: RuntimeClient) -> APIRouter:
    router = APIRouter(prefix="/model-providers", tags=["model-providers"])

    @router.get("/declarations", response_model=DeclarationsOut)
    async def model_provider_declarations(
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """可以接入的供应商声明：显示名、密钥表单字段、能不能自己加模型、内置的模型。"""

        return await relay(runtime, "GET", "model-providers/declarations", actor=principal.user_id)

    @router.get("", response_model=ModelProvidersOut)
    async def model_providers(
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """接入的全部供应商，带打码的密钥、默认密钥与合并后的模型列表。"""

        return await relay(runtime, "GET", "model-providers", actor=principal.user_id)

    @router.post("", response_model=ModelProviderOut, status_code=201)
    async def create_model_provider(
        body: ModelProviderCreateIn,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """按一份声明接入一个供应商，启用、还没有密钥。"""

        return await relay(runtime, "POST", "model-providers", actor=principal.user_id, body=body)

    @router.patch("/{provider_id}", response_model=ModelProviderOut)
    async def update_model_provider(
        provider_id: uuid.UUID,
        body: ModelProviderUpdateIn,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """改显示名、启停或默认密钥。"""

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
        """删一个供应商连同它的密钥与模型；有 agent 的草稿或当前版本写着它、或它有默认模型是 409。"""

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
        """新建一把密钥：先试连，通过才保存；供应商的第一把成为默认密钥。"""

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
        """试连，不保存；结果在答复里，没通过也是 200。"""

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
        """改名或改字段；字段有变化时先试连，通过才保存。"""

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
        """删一把密钥；默认密钥不能删。"""

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
        """自己加一个模型；声明允许自己加模型时才能加。"""

        return await relay(
            runtime,
            "POST",
            admin_path("model-providers", str(provider_id), "models"),
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
        """启停一个模型，或改自己加的模型的属性。模型名放在路径最后，可以带斜杠。"""

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
        """删一个自己加的模型；声明里的模型只能停用。"""

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
        """各类型的默认模型。"""

        return await relay(runtime, "GET", "default-models", actor=principal.user_id)

    @router.put("/{model_type}", response_model=DefaultModelOut)
    async def set_default_model(
        model_type: ModelType,
        body: DefaultModelIn,
        principal: Annotated[Principal, require_permission(_MANAGE)],
    ) -> Response:
        """把这个类型的默认模型设成某供应商一个已启用的模型。"""

        return await relay(
            runtime,
            "PUT",
            admin_path("default-models", model_type),
            actor=principal.user_id,
            body=body,
        )

    return router


__all__ = ["create_default_models_router", "create_model_providers_router"]
