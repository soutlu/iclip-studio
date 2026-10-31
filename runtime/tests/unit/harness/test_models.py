"""模型适配的自定义分支：端点经客户端注入，chat 与 responses 都保留思考设置。"""

from __future__ import annotations

from pydantic_ai.models.openai import OpenAIChatModel

from agent_runtime.harness.models import (
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
    thinking: ThinkingEffort | None = None,
) -> ModelSpec:
    return ModelSpec(
        name=name,
        provider=provider,
        model=model,
        api=api,
        api_key="sk-test",
        base_url=BAILIAN,
        thinking=thinking,
    )


def test_provider_without_base_url_param_still_gets_configured_endpoint() -> None:
    """deepseek 构造器不接受 base_url，通过 openai_client 传入端点。"""

    model = build_model(spec(name="ds", provider="deepseek", model="deepseek-chat"))

    assert isinstance(model, OpenAIChatModel)
    assert model.base_url.rstrip("/") == BAILIAN


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
