"""模型适配的自定义分支：端点经客户端注入，chat 与 responses 都保留思考设置；gemini 走原生接口。
思考档位按建出的模型类写：Gemini 与 OpenRouter 用通用 ``thinking``，别的用 ``openai_reasoning_effort``，
都能从模型读回。"""

from __future__ import annotations

from collections.abc import Callable

import pytest
from openai import AsyncOpenAI
from pydantic_ai.models.google import GoogleModel
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.models.openrouter import OpenRouterModel

from agent_runtime.harness.models import (
    ModelApi,
    ModelSpec,
    ThinkingEffort,
    build_model,
    thinking_effort_of,
)

BAILIAN = "https://dashscope.aliyuncs.com/compatible-mode/v1"
GEMINI_OFFICIAL = "https://generativelanguage.googleapis.com/"
OPENROUTER_OFFICIAL = "https://openrouter.ai/api/v1"
RELAY = "https://relay.example/v1"


def spec(
    *,
    name: str = "qwen",
    provider: str = "alibaba",
    model: str = "qwen3.8-max",
    api: ModelApi = "chat",
    base_url: str | None = BAILIAN,
    thinking: ThinkingEffort | None = None,
) -> ModelSpec:
    return ModelSpec(
        name=name,
        provider=provider,
        model=model,
        api=api,
        api_key="sk-test",
        base_url=base_url,
        thinking=thinking,
    )


def gemini(*, base_url: str | None = None, thinking: ThinkingEffort | None = None) -> ModelSpec:
    return spec(
        name="gemini/gemini-3.8-flash",
        provider="google",
        model="gemini-3.8-flash",
        api="gemini",
        base_url=base_url,
        thinking=thinking,
    )


def openrouter(*, base_url: str | None = None, thinking: ThinkingEffort | None = None) -> ModelSpec:
    return spec(
        name="openrouter/google/gemini-3.8-flash",
        provider="openrouter",
        model="google/gemini-3.8-flash",
        api="chat",
        base_url=base_url,
        thinking=thinking,
    )


def openrouter_endpoint(model: OpenRouterModel) -> str:
    client = model.client
    assert isinstance(client, AsyncOpenAI)
    return str(client.base_url).rstrip("/")


def test_provider_without_base_url_param_still_gets_configured_endpoint() -> None:
    """deepseek 构造器不接受 base_url，通过 openai_client 传入端点。"""

    model = build_model(spec(name="ds", provider="deepseek", model="deepseek-chat"))

    assert isinstance(model, OpenAIChatModel)
    assert model.base_url.rstrip("/") == BAILIAN


def test_bailian_thinking_lands_as_reasoning_effort_on_both_apis() -> None:
    """chat 分派入口不接受 settings，需额外构造模型并保持两种 API 设置一致；档位能从模型读回。"""

    for api in ("chat", "responses"):
        model = build_model(spec(api=api, thinking="medium"))
        assert model.settings == {"openai_reasoning_effort": "medium"}
        assert thinking_effort_of(model) == "medium"
    off = build_model(spec(api="chat", thinking="none"))
    assert off.settings == {"openai_reasoning_effort": "none"}
    assert thinking_effort_of(off) == "none"
    assert isinstance(build_model(spec(api="chat", thinking="low")), OpenAIChatModel)
    plain = build_model(spec())
    assert plain.settings is None
    assert thinking_effort_of(plain) is None


def test_gemini_builds_the_native_model_on_the_official_or_given_address() -> None:
    official = build_model(gemini())
    relayed = build_model(gemini(base_url=RELAY))

    assert isinstance(official, GoogleModel)
    assert official.model_name == "gemini-3.8-flash"
    assert official.base_url == GEMINI_OFFICIAL
    assert isinstance(relayed, GoogleModel)
    assert relayed.base_url == RELAY


def test_openrouter_chat_builds_its_own_model_class_on_the_official_or_given_address() -> None:
    official = build_model(openrouter())
    relayed = build_model(openrouter(base_url=RELAY, thinking="high"))

    assert isinstance(official, OpenRouterModel)
    assert openrouter_endpoint(official) == OPENROUTER_OFFICIAL
    # 带设置时按选出的类再造一次，类与端点都不能丢。
    assert isinstance(relayed, OpenRouterModel)
    assert openrouter_endpoint(relayed) == RELAY


@pytest.mark.parametrize("build", [gemini, openrouter], ids=["gemini", "openrouter"])
def test_gemini_and_openrouter_use_the_unified_thinking_setting(
    build: Callable[..., ModelSpec],
) -> None:
    effort = build_model(build(thinking="low"))
    off = build_model(build(thinking="none"))
    plain = build_model(build())

    assert effort.settings == {"thinking": "low"}
    assert thinking_effort_of(effort) == "low"
    assert off.settings == {"thinking": False}
    assert thinking_effort_of(off) == "none"
    assert plain.settings is None
    assert thinking_effort_of(plain) is None
