"""模型合并按名字和类型唯一；自定义模型成为内置模型后保留启停状态。"""

from __future__ import annotations

import pytest

from agent_runtime.config.model_providers.catalog import (
    CredentialFieldDeclaration,
    ModelDeclaration,
    ProviderDeclaration,
)
from agent_runtime.config.model_providers.models import (
    SOURCE_CUSTOM,
    SOURCE_DECLARED,
    ModelProperties,
    ModelSetting,
    ModelType,
)
from agent_runtime.config.model_providers.rules import merge_models


@pytest.fixture
def declaration() -> ProviderDeclaration:
    return ProviderDeclaration(
        name="acme",
        label="Acme",
        pydantic_ai_provider="openai",
        apis=("chat", "responses"),
        credential_fields=(
            CredentialFieldDeclaration(
                name="api_key", label="API Key", type="secret", required=True
            ),
        ),
        custom_models=True,
        models=(ModelDeclaration(name="m1", type="llm", api="responses", context_size=1024),),
    )


@pytest.mark.parametrize("enabled", [True, False])
def test_custom_model_becoming_declared_keeps_enabled_state(
    declaration: ProviderDeclaration, enabled: bool
) -> None:
    setting = ModelSetting(
        name="m1",
        type="llm",
        source=SOURCE_CUSTOM,
        properties=ModelProperties(api="chat", context_size=512, thinking=()),
        enabled=enabled,
    )

    (model,) = merge_models(declaration, (setting,))

    assert (model.name, model.type, model.source) == ("m1", "llm", SOURCE_DECLARED)
    assert model.properties == declaration.models[0].properties()
    assert model.enabled is enabled


@pytest.mark.parametrize(
    ("name", "model_type"),
    [("custom-model", "llm"), ("m1", "embedding")],
    ids=["different-name", "same-name-different-type"],
)
def test_custom_models_outside_declared_keys_keep_their_properties_and_state(
    declaration: ProviderDeclaration, name: str, model_type: ModelType
) -> None:
    setting = ModelSetting(
        name=name,
        type=model_type,
        source=SOURCE_CUSTOM,
        properties=ModelProperties(
            api="chat" if model_type == "llm" else None, context_size=512, thinking=()
        ),
        enabled=False,
    )

    declared, custom = merge_models(declaration, (setting,))

    assert declared.enabled is True
    assert (custom.name, custom.type, custom.source) == (name, model_type, SOURCE_CUSTOM)
    assert custom.properties == setting.properties
    assert custom.enabled is False
