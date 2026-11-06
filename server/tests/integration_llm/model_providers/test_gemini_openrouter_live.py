from __future__ import annotations

import os

import pytest
from agent_runtime.assembly.models import build_provider_model
from agent_runtime.config.model_providers.catalog import load_declarations
from agent_runtime.config.model_providers.models import ModelProperties, ProviderModel
from agent_runtime.model_vocab import ModelApi
from pydantic_ai.direct import model_request
from pydantic_ai.messages import ModelRequest, TextPart

PROMPT = "用一个词回答：晴天的天空是什么颜色？"


def _env(prefix: str) -> tuple[dict[str, str], str]:
    required = (f"{prefix}_API_KEY", f"{prefix}_MODEL")
    missing = [name for name in required if not os.environ.get(name, "").strip()]
    if missing:
        pytest.skip(f"缺少环境变量 {', '.join(missing)}，跳过真实调用")
    fields = {"api_key": os.environ[f"{prefix}_API_KEY"].strip()}
    base_url = os.environ.get(f"{prefix}_BASE_URL", "").strip()
    if base_url:
        fields["base_url"] = base_url
    return fields, os.environ[f"{prefix}_MODEL"].strip()


@pytest.mark.parametrize(
    ("declaration", "prefix", "api"),
    [("gemini", "GEMINI", "gemini"), ("openrouter", "OPENROUTER", "chat")],
)
async def test_a_custom_model_answers_with_thinking_on(
    declaration: str, prefix: str, api: ModelApi
) -> None:
    fields, name = _env(prefix)
    model = ProviderModel(
        name=name,
        type="llm",
        source="custom",
        properties=ModelProperties(api=api, context_size=None, thinking=("low",)),
        enabled=True,
    )
    built = build_provider_model(load_declarations()[declaration], model, fields, "low")

    response = await model_request(built, [ModelRequest.user_text_prompt(PROMPT)])

    text = "".join(part.content for part in response.parts if isinstance(part, TextPart))
    assert text.strip(), response.parts
