"""试连 Gemini 与 OpenRouter：按随代码发布的声明与自己加的模型建出真实的模型类，请求经替身传输层答复，
不连网。请求要发到声明的接口地址（没填走官方地址）、带上 API Key 与输出上限；上游拒绝时原因里没有密钥。"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import httpx2
import pytest

from agent_runtime.assembly.models import PydanticAiCredentialProbe
from agent_runtime.config.model_providers.catalog import load_declarations
from agent_runtime.config.model_providers.models import ModelProperties, ProviderModel
from agent_runtime.harness.probe import PROBE_MAX_TOKENS
from agent_runtime.model_vocab import ModelApi, ThinkingEffort

KEY = "sk-test-not-a-real-key"
RELAY = "https://relay.example/v1"

GEMINI_REPLY: dict[str, Any] = {
    "candidates": [
        {"content": {"role": "model", "parts": [{"text": "pong"}]}, "finishReason": "STOP"}
    ],
    "usageMetadata": {"promptTokenCount": 1, "candidatesTokenCount": 1, "totalTokenCount": 2},
}

CHAT_REPLY: dict[str, Any] = {
    "id": "gen-1",
    "object": "chat.completion",
    "created": 0,
    "model": "openai/gpt-6.1-terra",
    "provider": "OpenAI",
    "choices": [
        {
            "index": 0,
            "message": {"role": "assistant", "content": "pong"},
            "finish_reason": "stop",
        }
    ],
    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
}


@dataclass
class Upstream:
    """替身上游：记下每个请求，按 ``status`` 与 ``body`` 答复。"""

    status: int
    body: dict[str, Any]
    requests: list[httpx2.Request] = field(default_factory=list)

    def answer(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        return httpx2.Response(self.status, json=self.body)

    def sent(self) -> tuple[httpx2.Request, dict[str, Any]]:
        (request,) = self.requests
        return request, json.loads(request.content)


@pytest.fixture
def upstream(monkeypatch: pytest.MonkeyPatch) -> Callable[[int, dict[str, Any]], Upstream]:
    """把 httpx2 的默认传输层换成替身：两家 SDK 建的客户端都经它发请求，连不到网。"""

    def install(status: int, body: dict[str, Any]) -> Upstream:
        fake = Upstream(status, body)

        async def handle(_transport: object, request: httpx2.Request) -> httpx2.Response:
            await request.aread()
            return fake.answer(request)

        monkeypatch.setattr(httpx2.AsyncHTTPTransport, "handle_async_request", handle)
        return fake

    return install


def custom_llm(name: str, api: ModelApi, thinking: tuple[ThinkingEffort, ...]) -> ProviderModel:
    return ProviderModel(
        name=name,
        type="llm",
        source="custom",
        properties=ModelProperties(api=api, context_size=None, thinking=thinking),
        enabled=True,
    )


GEMINI_MODEL = custom_llm("gemini-3.8-flash", "gemini", ("low", "medium", "high"))
OPENROUTER_MODEL = custom_llm("openai/gpt-6.1-terra", "chat", ("none", "low", "high"))


@pytest.mark.parametrize(
    ("fields", "endpoint"),
    [
        ({"api_key": KEY}, "https://generativelanguage.googleapis.com/"),
        ({"api_key": KEY, "base_url": RELAY}, f"{RELAY}/"),
    ],
    ids=["official", "relay"],
)
async def test_gemini_probe_calls_generate_content_on_the_declared_address(
    upstream: Callable[[int, dict[str, Any]], Upstream], fields: dict[str, str], endpoint: str
) -> None:
    fake = upstream(200, GEMINI_REPLY)

    result = await PydanticAiCredentialProbe().probe(
        load_declarations()["gemini"], GEMINI_MODEL, fields
    )

    assert result.ok, result.reason
    request, body = fake.sent()
    assert str(request.url).startswith(endpoint)
    assert str(request.url).endswith("/models/gemini-3.8-flash:generateContent")
    assert request.headers["x-goog-api-key"] == KEY
    assert body["generationConfig"]["maxOutputTokens"] == PROBE_MAX_TOKENS


@pytest.mark.parametrize(
    ("fields", "endpoint"),
    [
        ({"api_key": KEY}, "https://openrouter.ai/api/v1"),
        ({"api_key": KEY, "base_url": RELAY}, RELAY),
    ],
    ids=["official", "relay"],
)
async def test_openrouter_probe_calls_chat_completions_with_thinking_off(
    upstream: Callable[[int, dict[str, Any]], Upstream], fields: dict[str, str], endpoint: str
) -> None:
    fake = upstream(200, CHAT_REPLY)

    result = await PydanticAiCredentialProbe().probe(
        load_declarations()["openrouter"], OPENROUTER_MODEL, fields
    )

    assert result.ok, result.reason
    request, body = fake.sent()
    assert str(request.url) == f"{endpoint}/chat/completions"
    assert request.headers["authorization"] == f"Bearer {KEY}"
    assert body["model"] == "openai/gpt-6.1-terra"
    assert body["max_tokens"] == PROBE_MAX_TOKENS
    # 模型允许 none，试连就关掉思考；通用 thinking=False 经 OpenRouter 适配器写成 reasoning。
    assert body["reasoning"] == {"effort": "none"}


@pytest.mark.parametrize(
    ("declaration", "model", "error"),
    [
        (
            "gemini",
            GEMINI_MODEL,
            {"error": {"code": 400, "message": f"API key not valid: {KEY}", "status": "x"}},
        ),
        ("openrouter", OPENROUTER_MODEL, {"error": {"code": 401, "message": f"No auth: {KEY}"}}),
    ],
    ids=["gemini", "openrouter"],
)
async def test_a_rejected_key_fails_without_echoing_it(
    upstream: Callable[[int, dict[str, Any]], Upstream],
    declaration: str,
    model: ProviderModel,
    error: dict[str, Any],
) -> None:
    upstream(401, error)

    result = await PydanticAiCredentialProbe().probe(
        load_declarations()[declaration], model, {"api_key": KEY}
    )

    assert not result.ok
    assert result.reason is not None
    assert result.reason.startswith("API Key 无效或没有权限（HTTP 401）")
    assert KEY not in result.reason


async def test_an_openrouter_model_without_its_author_says_why_before_any_request(
    upstream: Callable[[int, dict[str, Any]], Upstream],
) -> None:
    fake = upstream(200, CHAT_REPLY)

    result = await PydanticAiCredentialProbe().probe(
        load_declarations()["openrouter"], custom_llm("gpt-x", "chat", ()), {"api_key": KEY}
    )

    # 官方建模型时就拒绝不带作者的名字，原因原样给人看；没有发出请求。
    assert not result.ok
    assert result.reason is not None
    assert result.reason.startswith("按声明建不出模型：OpenRouter model names must be prefixed")
    assert "'openai/gpt-x'" in result.reason
    assert fake.requests == []
