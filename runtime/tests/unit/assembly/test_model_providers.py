"""按供应商声明建模型：接口照声明选模型类，思考档位只收模型允许的；声明里的 provider 名官方都认。"""

from __future__ import annotations

import pytest
from pydantic_ai.models.openai import OpenAIChatModel, OpenAIResponsesModel

from agent_runtime.assembly.models import build_provider_model, require_known_providers
from agent_runtime.config.model_providers.catalog import Declarations, load_declarations
from agent_runtime.config.model_providers.models import ModelProperties, ProviderModel
from agent_runtime.harness.models import thinking_effort_of

FIELDS = {"api_key": "sk-test", "base_url": "https://dashscope.test/compatible-mode/v1"}


def declared(name: str) -> ProviderModel:
    bailian = load_declarations()["bailian"]
    (model,) = [one for one in bailian.models if one.name == name]
    return ProviderModel(
        name=model.name,
        type=model.type,
        source="declared",
        properties=model.properties(),
        enabled=True,
    )


def test_responses_models_build_with_the_responses_client() -> None:
    bailian = load_declarations()["bailian"]

    built = build_provider_model(bailian, declared("qwen3.8-flash"), FIELDS, "high")

    assert isinstance(built, OpenAIResponsesModel)
    assert built.model_name == "qwen3.8-flash"
    assert thinking_effort_of(built) == "high"


def test_chat_models_build_with_the_chat_client() -> None:
    bailian = load_declarations()["bailian"]

    built = build_provider_model(bailian, declared("ZHIPU/GLM-5.3-Flash"), FIELDS, None)

    assert isinstance(built, OpenAIChatModel)
    assert not isinstance(built, OpenAIResponsesModel)
    assert thinking_effort_of(built) is None


def test_thinking_outside_the_model_allowance_is_refused() -> None:
    bailian = load_declarations()["bailian"]

    with pytest.raises(ValueError, match="xhigh"):
        build_provider_model(bailian, declared("qwen3.8-flash"), FIELDS, "xhigh")


def test_non_llm_models_are_refused() -> None:
    bailian = load_declarations()["bailian"]
    embedding = ProviderModel(
        name="text-embedding-v4",
        type="embedding",
        source="custom",
        properties=ModelProperties(api=None, context_size=None, thinking=()),
        enabled=True,
    )

    with pytest.raises(ValueError, match="embedding"):
        build_provider_model(bailian, embedding, FIELDS, None)


def test_shipped_declarations_name_known_providers() -> None:
    require_known_providers(load_declarations())


def test_unknown_providers_fail_startup() -> None:
    bailian = load_declarations()["bailian"]
    broken = bailian.model_copy(update={"pydantic_ai_provider": "no-such-provider"})

    with pytest.raises(RuntimeError, match="no-such-provider"):
        require_known_providers(Declarations({"bailian": broken}))
