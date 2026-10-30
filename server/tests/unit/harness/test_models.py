"""命名模型装配契约：端点与 key 来自配置、chat/responses 分派、非法组合即失败。"""

from __future__ import annotations

from typing import cast

import pytest
from pydantic_ai.models.openai import OpenAIChatModel, OpenAIResponsesModel

from iclip.harness.models import (
    ModelApi,
    ModelSpec,
    ThinkingEffort,
    build_model,
    thinking_effort_of,
)

BAILIAN = "https://dashscope.aliyuncs.com/compatible-mode/v1"


def spec(
    *,
    name: str = "qwen",
    provider: str = "alibaba",
    model: str = "qwen3.8-max",
    api: ModelApi = "chat",
    api_key: str = "sk-test",
    base_url: str | None = BAILIAN,
    thinking: ThinkingEffort | None = None,
) -> ModelSpec:
    return ModelSpec(
        name=name,
        provider=provider,
        model=model,
        api=api,
        api_key=api_key,
        base_url=base_url,
        thinking=thinking,
    )


def test_chat_uses_official_dispatch_with_configured_endpoint() -> None:
    model = build_model(spec())

    assert isinstance(model, OpenAIChatModel)
    assert model.base_url.rstrip("/") == BAILIAN
    assert model.system == "alibaba"


def test_responses_api_selected_explicitly() -> None:
    """alibaba 默认分派到 chat，responses 需显式配置。"""

    model = build_model(spec(api="responses"))

    assert isinstance(model, OpenAIResponsesModel)
    assert model.base_url.rstrip("/") == BAILIAN


def test_vendor_profile_survives_on_both_apis() -> None:

    for api in ("chat", "responses"):
        profile = dict(build_model(spec(api=api)).profile)
        transformer = cast("type[object]", profile["json_schema_transformer"])
        assert transformer.__name__ == "InlineDefsJsonSchemaTransformer"
        assert profile["supports_json_schema_output"] is False


def test_provider_without_base_url_param_still_gets_configured_endpoint() -> None:
    """deepseek 构造器不接受 base_url，通过 openai_client 传入端点。"""

    model = build_model(spec(name="ds", provider="deepseek", model="deepseek-chat"))

    assert isinstance(model, OpenAIChatModel)
    assert model.base_url.rstrip("/") == BAILIAN


def test_base_url_absent_uses_provider_default() -> None:
    model = build_model(spec(base_url=None))

    assert (model.base_url or "").rstrip("/") == (
        "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
    )


def test_provider_owning_model_class_is_not_flattened() -> None:

    model = build_model(
        spec(name="local", provider="ollama", model="qwen3-8b", base_url="http://x/v1")
    )

    assert type(model).__name__ == "OllamaModel"


def test_unknown_provider_fails() -> None:
    with pytest.raises(Exception, match="no-such-vendor"):
        build_model(spec(provider="no-such-vendor"))


def test_thinking_lands_in_model_settings_on_both_apis() -> None:
    """chat 分派入口不接受 settings，需额外构造模型并保持两种 API 设置一致；档位能从模型读回。"""

    for api in ("chat", "responses"):
        model = build_model(spec(api=api, thinking="medium"))
        assert model.settings == {"openai_reasoning_effort": "medium"}
        assert thinking_effort_of(model) == "medium"
    assert isinstance(build_model(spec(api="chat", thinking="low")), OpenAIChatModel)
    plain = build_model(spec())
    assert plain.settings is None
    assert thinking_effort_of(plain) is None
