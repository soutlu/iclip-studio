"""模型供应商接到 Agent 引擎：按「声明 + 模型 + 密钥字段 + 思考档位」建出模型，试连端口的实现，以及启动时
核对声明里的 provider 名官方都认。"""

from __future__ import annotations

from collections.abc import Mapping

from agent_runtime.config.model_providers.public import (
    API_KEY_FIELD,
    BASE_URL_FIELD,
    Declarations,
    ProbeResult,
    ProviderDeclaration,
    ProviderModel,
)
from agent_runtime.harness.models import BuiltModel, ModelSpec, build_model, provider_known
from agent_runtime.harness.probe import probe_model
from agent_runtime.model_vocab import ThinkingEffort


def provider_model_spec(
    declaration: ProviderDeclaration,
    model: ProviderModel,
    fields: Mapping[str, str],
    thinking: ThinkingEffort | None,
) -> ModelSpec:
    """``fields`` 是明文密钥字段。不是 llm、思考档位不在模型允许的档位里都抛 ``ValueError``。"""

    api = model.properties.api
    if api is None:
        raise ValueError(f"{model.name} 是 {model.type} 模型，不能当对话模型用")
    if thinking is not None and thinking not in model.properties.thinking:
        raise ValueError(f"{model.name} 不能设思考档位 {thinking}")
    return ModelSpec(
        name=f"{declaration.name}/{model.name}",
        provider=declaration.pydantic_ai_provider,
        model=model.name,
        api=api,
        api_key=fields[API_KEY_FIELD],
        base_url=fields.get(BASE_URL_FIELD),
        thinking=thinking,
    )


def build_provider_model(
    declaration: ProviderDeclaration,
    model: ProviderModel,
    fields: Mapping[str, str],
    thinking: ThinkingEffort | None,
) -> BuiltModel:
    """按供应商声明建出 pydantic-ai 模型；规则见 ``provider_model_spec`` 与 ``build_model``。"""

    return build_model(provider_model_spec(declaration, model, fields, thinking))


def require_known_providers(declarations: Declarations) -> None:
    """声明里的 ``pydantic_ai_provider`` 官方不认就启动失败。"""

    unknown = sorted(
        f"{name}（{declaration.pydantic_ai_provider}）"
        for name, declaration in declarations.items()
        if not provider_known(declaration.pydantic_ai_provider)
    )
    if unknown:
        raise RuntimeError(f"供应商声明的 pydantic_ai_provider 官方不认：{'、'.join(unknown)}")


class PydanticAiCredentialProbe:
    """``CredentialProbe`` 的实现：用这组字段建出模型，发一个最小的请求。思考档位能关就关，答得快。"""

    async def probe(
        self, declaration: ProviderDeclaration, model: ProviderModel, fields: Mapping[str, str]
    ) -> ProbeResult:
        thinking: ThinkingEffort | None = "none" if "none" in model.properties.thinking else None
        outcome = await probe_model(
            lambda: build_provider_model(declaration, model, fields, thinking),
            label=f"{declaration.name}/{model.name}",
            secrets=[fields[name] for name in declaration.secret_fields if name in fields],
        )
        return ProbeResult(ok=outcome.ok, elapsed_ms=outcome.elapsed_ms, reason=outcome.reason)


__all__ = [
    "PydanticAiCredentialProbe",
    "build_provider_model",
    "provider_model_spec",
    "require_known_providers",
]
