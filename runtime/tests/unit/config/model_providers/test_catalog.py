"""供应商声明：随代码发布的声明能加载；形状不对的声明在启动时就报错，模型的接口只能是声明的 apis 之一。"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
import yaml

from agent_runtime.config.model_providers.catalog import ModelDeclaration, load_declarations
from agent_runtime.config.model_providers.rules import custom_model, merged_fields, new_fields
from agent_runtime.errors import ValidationFailed
from agent_runtime.model_vocab import ModelApi


def valid() -> dict[str, Any]:
    return {
        "name": "acme",
        "label": "Acme",
        "pydantic_ai_provider": "openai",
        "apis": ["chat", "responses"],
        "credential_fields": [
            {"name": "api_key", "label": "API Key", "type": "secret", "required": True},
            {"name": "base_url", "label": "接口地址", "type": "text", "default": "https://x.test"},
        ],
        "custom_models": False,
        "models": [{"name": "m1", "type": "llm", "api": "chat", "thinking": ["none", "high"]}],
    }


def write(directory: Path, declaration: dict[str, Any], *, stem: str = "acme") -> Path:
    (directory / f"{stem}.yaml").write_text(yaml.safe_dump(declaration), encoding="utf-8")
    return directory


def _with(**changes: Any) -> dict[str, Any]:
    declaration = valid()
    declaration.update(changes)
    return declaration


def _model(**fields: Any) -> dict[str, Any]:
    return {"name": "m1", "type": "llm", "api": "chat", **fields}


@pytest.mark.parametrize(
    ("declaration", "reason"),
    [
        pytest.param(_with(region="cn"), "region", id="unknown-provider-field"),
        pytest.param(_with(models=[_model(max_tokens=10)]), "max_tokens", id="unknown-model-field"),
        pytest.param(
            _with(models=[_model(), _model(api="responses")]), "重名", id="duplicate-model"
        ),
        pytest.param(
            _with(models=[_model(thinking=["turbo"])]), "thinking", id="thinking-not-an-effort"
        ),
        pytest.param(_with(models=[{"name": "m1", "type": "llm"}]), "api", id="llm-without-api"),
        pytest.param(
            _with(models=[_model(api="gemini")]), "不在 apis 里", id="model-api-not-offered"
        ),
        pytest.param(_with(apis=[]), "apis", id="no-apis"),
        pytest.param(_with(apis=["chat", "chat"]), "重复接口", id="duplicate-apis"),
        pytest.param(_with(apis=["grpc"]), "apis", id="unknown-api"),
        pytest.param(
            _with(models=[{"name": "e1", "type": "embedding", "api": "chat"}]),
            "只有 llm",
            id="embedding-with-api",
        ),
        pytest.param(
            _with(
                credential_fields=[
                    {"name": "api_key", "label": "Key", "type": "secret", "required": True},
                    {"name": "region", "label": "地域", "type": "text"},
                ]
            ),
            "region",
            id="field-the-model-builder-cannot-use",
        ),
        pytest.param(
            _with(credential_fields=[{"name": "base_url", "label": "地址", "type": "text"}]),
            "api_key",
            id="no-api-key",
        ),
    ],
)
def test_malformed_declarations_fail_startup(
    tmp_path: Path, declaration: dict[str, Any], reason: str
) -> None:
    with pytest.raises(RuntimeError, match=r"acme\.yaml") as caught:
        load_declarations(write(tmp_path, declaration))

    assert reason in str(caught.value)


def test_declaration_name_must_match_its_file(tmp_path: Path) -> None:
    with pytest.raises(RuntimeError, match="文件名"):
        load_declarations(write(tmp_path, valid(), stem="other"))


def test_an_empty_declarations_directory_fails_startup(tmp_path: Path) -> None:
    with pytest.raises(RuntimeError, match="没有供应商声明"):
        load_declarations(tmp_path)


def test_shipped_declarations_load_with_their_apis_and_address_field() -> None:
    declarations = load_declarations()

    assert {name: (one.pydantic_ai_provider, one.apis) for name, one in declarations.items()} == {
        "bailian": ("alibaba", ("responses", "chat")),
        "gemini": ("google", ("gemini",)),
        "openai-compatible": ("openai", ("chat", "responses")),
        "openrouter": ("openrouter", ("chat",)),
        "volcengine": ("openai", ("chat", "responses")),
    }
    addresses = {
        name: (field.required, field.default)
        for name, one in declarations.items()
        if (field := one.field("base_url")) is not None
    }
    assert addresses == {
        "bailian": (True, "https://dashscope.aliyuncs.com/compatible-mode/v1"),
        # 不填走官方地址。
        "gemini": (False, None),
        "openrouter": (False, None),
        "volcengine": (True, "https://ark.cn-beijing.volces.com/api/v3"),
        # 没有官方地址，要自己填。
        "openai-compatible": (True, None),
    }
    for name in ("gemini", "openrouter", "openai-compatible"):
        assert declarations[name].custom_models is True
        assert declarations[name].models == ()


def test_openai_compatible_needs_an_address() -> None:
    declaration = load_declarations()["openai-compatible"]

    with pytest.raises(ValidationFailed, match="接口地址"):
        new_fields(declaration, {"api_key": "k"})
    assert new_fields(declaration, {"api_key": "k", "base_url": "https://x.test/v1"}) == {
        "api_key": "k",
        "base_url": "https://x.test/v1",
    }


@pytest.mark.parametrize(
    ("declaration", "api", "allowed"),
    [
        ("gemini", "chat", False),
        ("gemini", "gemini", True),
        ("openrouter", "responses", False),
        ("openrouter", "chat", True),
        ("bailian", "gemini", False),
        ("volcengine", "gemini", False),
        ("volcengine", "responses", True),
        ("openai-compatible", "gemini", False),
        ("openai-compatible", "chat", True),
    ],
)
def test_custom_models_may_only_use_the_providers_apis(
    declaration: str, api: ModelApi, allowed: bool
) -> None:
    shipped = load_declarations()[declaration]

    def add() -> ModelDeclaration:
        return custom_model(
            shipped, name="m", model_type="llm", api=api, context_size=None, thinking=()
        )

    if allowed:
        assert add().api == api
    else:
        with pytest.raises(ValidationFailed, match=f"只能走 .* 接口，不能走 {api}"):
            add()


def test_an_empty_address_is_dropped_so_the_model_uses_the_official_endpoint() -> None:
    gemini = load_declarations()["gemini"]

    assert new_fields(gemini, {"api_key": "k", "base_url": "  "}) == {"api_key": "k"}
    assert merged_fields(
        gemini, {"api_key": "k", "base_url": "https://x.test"}, {"base_url": ""}
    ) == {"api_key": "k"}
