from __future__ import annotations

import pytest
from openai import AsyncOpenAI
from pydantic_ai.models import Model
from pydantic_ai.models.google import GoogleModel
from pydantic_ai.models.openai import OpenAIChatModel, OpenAIResponsesModel
from pydantic_ai.models.openrouter import OpenRouterModel

from cue.assembly.models import build_provider_model
from cue.config.model_providers.catalog import load_declarations
from cue.config.model_providers.models import ModelProperties, ProviderModel
from cue.model_vocab import ModelApi

RELAY = "https://relay.example/v1"
ARK = "https://ark.cn-beijing.volces.com/api/v3"
BAILIAN = "https://dashscope.aliyuncs.com/compatible-mode/v1"

UNIFIED = {"thinking": "low"}
REASONING_EFFORT = {"openai_reasoning_effort": "low"}


def llm(name: str, api: ModelApi) -> ProviderModel:
    return ProviderModel(
        name=name,
        type="llm",
        source="custom",
        properties=ModelProperties(api=api, context_size=None, thinking=("none", "low")),
        enabled=True,
    )


def endpoint(model: Model) -> str:
    if isinstance(model, GoogleModel):
        return model.base_url
    client = getattr(model, "client", None)
    assert isinstance(client, AsyncOpenAI)
    return str(client.base_url).rstrip("/")


@pytest.mark.parametrize(
    ("declaration", "name", "api", "base_url", "model_class", "settings"),
    [
        ("bailian", "qwen-x", "responses", BAILIAN, OpenAIResponsesModel, REASONING_EFFORT),
        ("bailian", "qwen-x", "chat", BAILIAN, OpenAIChatModel, REASONING_EFFORT),
        ("gemini", "gemini-3.8-flash", "gemini", RELAY, GoogleModel, UNIFIED),
        ("openrouter", "openai/gpt-6.1-terra", "chat", RELAY, OpenRouterModel, UNIFIED),
        ("volcengine", "doubao-x", "chat", ARK, OpenAIChatModel, REASONING_EFFORT),
        ("volcengine", "doubao-x", "responses", ARK, OpenAIResponsesModel, REASONING_EFFORT),
        ("openai-compatible", "m", "chat", RELAY, OpenAIChatModel, REASONING_EFFORT),
        ("openai-compatible", "m", "responses", RELAY, OpenAIResponsesModel, REASONING_EFFORT),
    ],
)
def test_each_declared_api_builds_its_model_class_on_the_credential_address(
    declaration: str,
    name: str,
    api: ModelApi,
    base_url: str,
    model_class: type[Model],
    settings: dict[str, str],
) -> None:
    shipped = load_declarations()[declaration]
    assert api in shipped.apis

    model = build_provider_model(
        shipped, llm(name, api), {"api_key": "sk-test", "base_url": base_url}, "low"
    )

    assert type(model) is model_class
    assert model.model_name == name
    assert endpoint(model) == base_url
    assert model.settings == settings
