from __future__ import annotations

import json
from typing import Any

import httpx2
import pytest
from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

from cue.harness.models import ModelSpec, build_model
from cue.harness.titles import MAX_TITLE_CHARS, clean_title, title_generator

pytestmark = pytest.mark.unit


def _exploding() -> FunctionModel:
    def script(_messages: list[ModelMessage], _info: AgentInfo) -> ModelResponse:
        raise RuntimeError("模型这会儿不干活")

    return FunctionModel(script)


async def test_起标题只用最低思考档() -> None:
    seen: list[AgentInfo] = []

    def script(_messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        seen.append(info)
        return ModelResponse(parts=[TextPart("夜景延时素材生成")])

    await title_generator(FunctionModel(script))("帮我做一条夜景延时的短片")

    assert seen[0].model_settings is not None
    assert seen[0].model_settings.get("openai_reasoning_effort") == "low"


GEMINI_REPLY: dict[str, Any] = {
    "candidates": [
        {"content": {"role": "model", "parts": [{"text": "夜景延时"}]}, "finishReason": "STOP"}
    ],
}
CHAT_REPLY: dict[str, Any] = {
    "id": "c1",
    "object": "chat.completion",
    "created": 0,
    "model": "qwen3.8-max",
    "choices": [
        {
            "index": 0,
            "message": {"role": "assistant", "content": "夜景延时"},
            "finish_reason": "stop",
        }
    ],
}


def _stub_upstream(monkeypatch: pytest.MonkeyPatch, reply: dict[str, Any]) -> list[dict[str, Any]]:
    bodies: list[dict[str, Any]] = []

    async def handle(_transport: object, request: httpx2.Request) -> httpx2.Response:
        bodies.append(json.loads(await request.aread()))
        return httpx2.Response(200, json=reply)

    monkeypatch.setattr(httpx2.AsyncHTTPTransport, "handle_async_request", handle)
    return bodies


async def test_gemini_起标题用通用_thinking_写成最低档(monkeypatch: pytest.MonkeyPatch) -> None:
    bodies = _stub_upstream(monkeypatch, GEMINI_REPLY)
    model = build_model(
        ModelSpec(
            name="gemini/gemini-3.8-flash",
            provider="google",
            model="gemini-3.8-flash",
            api="gemini",
            api_key="k",
            base_url=None,
            thinking="high",
        )
    )

    assert await title_generator(model)("帮我做一条夜景延时的短片") == "夜景延时"

    (body,) = bodies
    assert body["generationConfig"]["thinkingConfig"]["thinking_level"] == "LOW"


async def test_openai_兼容的模型起标题用_reasoning_effort(monkeypatch: pytest.MonkeyPatch) -> None:
    bodies = _stub_upstream(monkeypatch, CHAT_REPLY)
    model = build_model(
        ModelSpec(
            name="bailian/qwen3.8-max",
            provider="alibaba",
            model="qwen3.8-max",
            api="chat",
            api_key="k",
            base_url="https://dashscope.example/v1",
            thinking="high",
        )
    )

    assert await title_generator(model)("帮我做一条夜景延时的短片") == "夜景延时"

    (body,) = bodies
    assert body["reasoning_effort"] == "low"


async def test_用户没打字就不叫模型() -> None:
    calls: list[AgentInfo] = []

    def script(_messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        calls.append(info)
        return ModelResponse(parts=[TextPart("凭空起的标题")])

    generate = title_generator(FunctionModel(script))

    assert await generate("   ") is None
    assert calls == []


async def test_模型炸了不抛出去() -> None:
    generate = title_generator(_exploding())

    assert await generate("帮我做一条夜景延时的短片") is None


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ('"夜景延时素材生成"', "夜景延时素材生成"),
        ("「夜景延时素材生成」", "夜景延时素材生成"),
        ("夜景延时素材生成\n\n这个标题突出了…", "夜景延时素材生成"),
        ("  夜景延时素材生成  ", "夜景延时素材生成"),
        ("", None),
        ("\n\n", None),
    ],
)
def test_收拾模型的输出(raw: str, expected: str | None) -> None:
    assert clean_title(raw) == expected


def test_话太多的截断() -> None:
    cleaned = clean_title("镜" * (MAX_TITLE_CHARS + 50))

    assert cleaned is not None
    assert len(cleaned) == MAX_TITLE_CHARS
