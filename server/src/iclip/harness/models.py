"""按配置装配命名模型。"""

from __future__ import annotations

import inspect
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal, cast

from openai import AsyncOpenAI
from pydantic_ai.models import Model, infer_model
from pydantic_ai.models.openai import OpenAIChatModelSettings, OpenAIResponsesModel
from pydantic_ai.providers import Provider, infer_provider_class

ModelApi = Literal["chat", "responses"]

ThinkingEffort = Literal["none", "minimal", "low", "medium", "high", "xhigh", "max"]
"""思考强度档位，即 OpenAI 方言的 ``reasoning.effort``。"""

BuiltModels = Mapping[str, Model]
"""模型名称到实例的映射。"""


@dataclass(frozen=True, slots=True)
class ModelSpec:
    """命名模型配置；省略 thinking 时使用供应方默认值。"""

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

    # 各家构造签名不统一：收 base_url 的直接传，只收 api_key 的走 openai_client。
    parameters = inspect.signature(provider_class.__init__).parameters
    if "base_url" in parameters:
        return cast("Provider[Any]", provider_class(api_key=spec.api_key, base_url=spec.base_url))
    if "openai_client" in parameters:
        client = AsyncOpenAI(base_url=spec.base_url, api_key=spec.api_key)
        return cast("Provider[Any]", provider_class(openai_client=client))
    raise RuntimeError(
        f"模型 {spec.name}：provider {spec.provider} 不支持自定义 base_url，请去掉该字段"
    )


def _model_settings(spec: ModelSpec) -> OpenAIChatModelSettings | None:
    if spec.thinking is None:
        return None
    # Qwen profile 未声明 supports_thinking，通用 thinking 会被忽略；使用 reasoning_effort。
    return OpenAIChatModelSettings(openai_reasoning_effort=spec.thinking)


def thinking_effort_of(model: Model) -> str | None:
    """读回 _model_settings 写进模型的思考档位；没配返回 None。"""

    settings = cast("Mapping[str, object] | None", model.settings)
    effort = None if settings is None else settings.get("openai_reasoning_effort")
    return effort if isinstance(effort, str) else None


def build_model(spec: ModelSpec) -> Model:
    """构造 Model，拒绝无效 provider 或配置组合。"""

    provider = _build_provider(spec)
    settings = _model_settings(spec)
    if spec.api == "chat":
        # 模型类由官方按 provider 名决定：Ollama、OpenRouter 等各有专属类。
        picked = infer_model(f"{spec.provider}:{spec.model}", provider_factory=lambda _: provider)
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
    return OpenAIResponsesModel(spec.model, provider=provider, settings=settings)


def build_models(specs: Sequence[ModelSpec]) -> BuiltModels:
    """按名称装配模型，每个名称共享一个实例。"""

    return {spec.name: build_model(spec) for spec in specs}


def rebuild_models(
    specs: Sequence[ModelSpec], previous_specs: Sequence[ModelSpec], previous: BuiltModels
) -> BuiltModels:
    """重载时只重建声明变了的模型；声明一字未改的沿用旧实例，客户端连接池不动。"""

    kept = {spec: previous[spec.name] for spec in previous_specs}
    return {spec.name: kept.get(spec) or build_model(spec) for spec in specs}


__all__ = [
    "BuiltModels",
    "ModelApi",
    "ModelSpec",
    "ThinkingEffort",
    "build_model",
    "build_models",
    "rebuild_models",
    "thinking_effort_of",
]
