"""按模型声明建出 pydantic-ai 模型。"""

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
"""装配出的一个模型实例；组合根经它引用模型类型，不直接 import 引擎。"""


@dataclass(frozen=True, slots=True)
class ModelSpec:
    """建一个模型要的配置；``name`` 只用于报错；省略 thinking 时使用供应方默认值。"""

    name: str
    provider: str
    model: str
    api: ModelApi
    api_key: str
    base_url: str | None
    thinking: ThinkingEffort | None = None


def _build_provider(spec: ModelSpec) -> Provider[Any]:
    """根据配置构造 provider，未知名称抛错。"""

    provider_class = cast("Any", infer_provider_class(spec.provider))
    if spec.base_url is None:
        return cast("Provider[Any]", provider_class(api_key=spec.api_key))

    # 各家构造签名不统一：收 base_url 的直接传，只收 api_key 的（如 OpenRouter、DeepSeek）走 openai_client。
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
    """官方认不认这个 provider 名。"""

    try:
        infer_provider_class(name)
    except ValueError:
        return False
    return True


_UNIFIED_THINKING_MODELS: Final = (GoogleModel, OpenRouterModel)
"""用通用 ``thinking`` 设档位的模型类：它们的适配器把它换成自家参数（Gemini 的 thinkingConfig、OpenRouter
的 reasoning）。别的类用 ``openai_reasoning_effort``：Qwen profile 未声明 supports_thinking，通用 thinking
会被忽略。"""


def _effort_settings(model_class: type[Model], thinking: ThinkingEffort) -> ModelSettings:
    if issubclass(model_class, _UNIFIED_THINKING_MODELS):
        return ModelSettings(thinking=False if thinking == "none" else thinking)
    return OpenAIChatModelSettings(openai_reasoning_effort=thinking)


def _model_settings(
    model_class: type[Model], thinking: ThinkingEffort | None
) -> ModelSettings | None:
    return None if thinking is None else _effort_settings(model_class, thinking)


def thinking_settings(model: Model, thinking: ThinkingEffort) -> ModelSettings:
    """给一次请求单独设思考档位的设置，按 ``model`` 的类写法与建模型时相同；请求的设置盖过模型自带的。"""

    return _effort_settings(type(model), thinking)


def thinking_effort_of(model: Model) -> str | None:
    """读回 _model_settings 写进模型的思考档位，``thinking=False`` 读作 ``none``；没配返回 None。"""

    settings = cast("Mapping[str, object] | None", model.settings)
    if settings is None:
        return None
    effort = settings.get("openai_reasoning_effort", settings.get("thinking"))
    if effort is False:
        return "none"
    return effort if isinstance(effort, str) else None


def build_model(spec: ModelSpec) -> Model:
    """构造 Model，拒绝无效 provider 或配置组合。``gemini`` 用这组 API Key 与接口地址直接连 Gemini 原生
    接口，没给地址走官方地址。"""

    if spec.api == "gemini":
        google = GoogleProvider(api_key=spec.api_key, base_url=spec.base_url)
        return GoogleModel(
            spec.model, provider=google, settings=_model_settings(GoogleModel, spec.thinking)
        )
    provider = _build_provider(spec)
    if spec.api == "chat":
        # 模型类由官方按 provider 名决定：Ollama、OpenRouter 等各有专属类。官方把 openai 分派到
        # Responses 模型，chat 要按 openai-chat 取 Chat Completions 模型。
        kind = "openai-chat" if spec.provider == "openai" else spec.provider
        picked = infer_model(f"{kind}:{spec.model}", provider_factory=lambda _: provider)
        settings = _model_settings(type(picked), spec.thinking)
        if settings is None:
            return picked
        # 官方的分派入口不收 settings，按它选出的类再造一次。
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
