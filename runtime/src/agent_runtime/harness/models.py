from __future__ import annotations

import inspect
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Final, cast

from openai import AsyncOpenAI
from pydantic_ai.models import Model, infer_model
from pydantic_ai.models.google import GoogleModel
from pydantic_ai.models.openai import OpenAIChatModelSettings, OpenAIResponsesModel
from pydantic_ai.models.openrouter import OpenRouterModel
from pydantic_ai.providers import Provider, infer_provider_class
from pydantic_ai.providers.google import GoogleProvider
from pydantic_ai.settings import ModelSettings

from agent_runtime.model_vocab import ModelApi, ThinkingEffort

BuiltModel = Model


@dataclass(frozen=True, slots=True)
class ModelSpec:
    name: str
    provider: str
    model: str
    api: ModelApi
    api_key: str
    base_url: str | None
    thinking: ThinkingEffort | None = None


def _build_provider(spec: ModelSpec) -> Provider[Any]:
    provider_class = cast("Any", infer_provider_class(spec.provider))
    if spec.base_url is None:
        return cast("Provider[Any]", provider_class(api_key=spec.api_key))

    parameters = inspect.signature(provider_class.__init__).parameters
    if "base_url" in parameters:
        return cast("Provider[Any]", provider_class(api_key=spec.api_key, base_url=spec.base_url))
    if "openai_client" in parameters:
        client = AsyncOpenAI(base_url=spec.base_url, api_key=spec.api_key)
        return cast("Provider[Any]", provider_class(openai_client=client))
    raise RuntimeError(
        f"模型 {spec.name}：provider {spec.provider} 不支持自定义 base_url，请去掉该字段"
    )


def provider_known(name: str) -> bool:
    try:
        infer_provider_class(name)
    except ValueError:
        return False
    return True


_UNIFIED_THINKING_MODELS: Final = (GoogleModel, OpenRouterModel)


def _effort_settings(model_class: type[Model], thinking: ThinkingEffort) -> ModelSettings:
    if issubclass(model_class, _UNIFIED_THINKING_MODELS):
        return ModelSettings(thinking=False if thinking == "none" else thinking)
    return OpenAIChatModelSettings(openai_reasoning_effort=thinking)


def _model_settings(
    model_class: type[Model], thinking: ThinkingEffort | None
) -> ModelSettings | None:
    return None if thinking is None else _effort_settings(model_class, thinking)


def thinking_settings(model: Model, thinking: ThinkingEffort) -> ModelSettings:
    return _effort_settings(type(model), thinking)


def thinking_effort_of(model: Model) -> str | None:
    settings = cast("Mapping[str, object] | None", model.settings)
    if settings is None:
        return None
    effort = settings.get("openai_reasoning_effort", settings.get("thinking"))
    if effort is False:
        return "none"
    return effort if isinstance(effort, str) else None


def build_model(spec: ModelSpec) -> Model:
    if spec.api == "gemini":
        google = GoogleProvider(api_key=spec.api_key, base_url=spec.base_url)
        return GoogleModel(
            spec.model, provider=google, settings=_model_settings(GoogleModel, spec.thinking)
        )
    provider = _build_provider(spec)
    if spec.api == "chat":
        kind = "openai-chat" if spec.provider == "openai" else spec.provider
        picked = infer_model(f"{kind}:{spec.model}", provider_factory=lambda _: provider)
        settings = _model_settings(type(picked), spec.thinking)
        if settings is None:
            return picked
        return cast(
            "Model", cast("Any", type(picked))(spec.model, provider=provider, settings=settings)
        )

    if not isinstance(provider.client, AsyncOpenAI):
        raise RuntimeError(
            f"模型 {spec.name}：api: responses 只适用于 OpenAI 兼容的 provider，"
            f"{spec.provider} 不是"
        )
    return OpenAIResponsesModel(
        spec.model,
        provider=provider,
        settings=_model_settings(OpenAIResponsesModel, spec.thinking),
    )


__all__ = [
    "BuiltModel",
    "ModelApi",
    "ModelSpec",
    "ThinkingEffort",
    "build_model",
    "provider_known",
    "thinking_effort_of",
    "thinking_settings",
]
