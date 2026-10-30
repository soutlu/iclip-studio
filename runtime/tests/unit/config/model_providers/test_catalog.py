"""供应商声明：随代码发布的声明能加载；形状不对的声明在启动时就报错。"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
import yaml

from agent_runtime.config.model_providers.catalog import load_declarations


def valid() -> dict[str, Any]:
    return {
        "name": "acme",
        "label": "Acme",
        "pydantic_ai_provider": "openai",
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


def test_shipped_declarations_load_with_the_current_model_interfaces() -> None:
    declarations = load_declarations()

    bailian = declarations["bailian"]
    by_name = {model.name: model for model in bailian.models}
    assert bailian.pydantic_ai_provider == "alibaba"
    assert bailian.custom_models is True
    assert bailian.secret_fields == {"api_key"}
    assert by_name["qwen3.8-flash"].api == "responses"
    assert by_name["ZHIPU/GLM-5.3-Flash"].api == "chat"
    assert all("high" in model.thinking for model in bailian.models)


def test_a_valid_declaration_loads(tmp_path: Path) -> None:
    declarations = load_declarations(write(tmp_path, valid()))

    assert list(declarations) == ["acme"]
    assert declarations["acme"].models[0].thinking == ("none", "high")


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
