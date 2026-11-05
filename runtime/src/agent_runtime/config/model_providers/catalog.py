from __future__ import annotations

from collections.abc import Iterator, Mapping
from pathlib import Path
from typing import Annotated, Final, Literal

import yaml
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    ValidationError,
    model_validator,
)

from agent_runtime.config.model_providers.models import (
    FIELD_SECRET,
    MAX_LABEL_CHARS,
    MAX_MODEL_NAME_CHARS,
    PROVIDER_NAME_PATTERN,
    CredentialFieldType,
    ModelProperties,
    ModelType,
)
from agent_runtime.model_vocab import ModelApi, ThinkingEffort

DECLARATIONS_DIR: Final = Path(__file__).resolve().parent / "declarations"

CredentialFieldName = Literal["api_key", "base_url"]

API_KEY_FIELD: Final = "api_key"
BASE_URL_FIELD: Final = "base_url"

Label = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_LABEL_CHARS)
]


class _Declaration(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class CredentialFieldDeclaration(_Declaration):
    name: CredentialFieldName
    label: Label
    type: CredentialFieldType
    required: bool = False
    default: str | None = None

    @model_validator(mode="after")
    def _no_secret_default(self) -> CredentialFieldDeclaration:
        if self.type == FIELD_SECRET and self.default is not None:
            raise ValueError(f"机密字段 {self.name} 不能有 default")
        return self


class ModelDeclaration(_Declaration):
    name: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_MODEL_NAME_CHARS)
    ]
    type: ModelType
    api: ModelApi | None = None
    context_size: int | None = Field(default=None, gt=0)
    thinking: tuple[ThinkingEffort, ...] = ()

    @model_validator(mode="after")
    def _fits_type(self) -> ModelDeclaration:
        if self.type == "llm":
            if self.api is None:
                raise ValueError(f"llm 模型 {self.name} 要写 api")
        else:
            if self.api is not None:
                raise ValueError(f"只有 llm 模型才有 api，{self.name} 是 {self.type}")
            if self.thinking:
                raise ValueError(f"只有 llm 模型才有 thinking，{self.name} 是 {self.type}")
        if len(set(self.thinking)) != len(self.thinking):
            raise ValueError(f"模型 {self.name} 的 thinking 有重复档位")
        return self

    def properties(self) -> ModelProperties:
        return ModelProperties(api=self.api, context_size=self.context_size, thinking=self.thinking)


class ProviderDeclaration(_Declaration):
    name: Annotated[str, StringConstraints(pattern=PROVIDER_NAME_PATTERN.pattern)]
    label: Label
    pydantic_ai_provider: Annotated[str, StringConstraints(min_length=1)]
    apis: tuple[ModelApi, ...] = Field(min_length=1)
    credential_fields: tuple[CredentialFieldDeclaration, ...] = Field(min_length=1)
    custom_models: bool = False
    models: tuple[ModelDeclaration, ...] = ()

    @model_validator(mode="after")
    def _consistent(self) -> ProviderDeclaration:
        names = [field.name for field in self.credential_fields]
        if len(set(names)) != len(names):
            raise ValueError("credential_fields 有重名字段")
        api_key = self.field(API_KEY_FIELD)
        if api_key is None or api_key.type != FIELD_SECRET or not api_key.required:
            raise ValueError("credential_fields 必须有必填的机密字段 api_key")
        if len(set(self.apis)) != len(self.apis):
            raise ValueError("apis 有重复接口")
        keys = [(model.name, model.type) for model in self.models]
        if len(set(keys)) != len(keys):
            raise ValueError("models 里有重名的同类型模型")
        for model in self.models:
            if model.api is not None and model.api not in self.apis:
                raise ValueError(f"模型 {model.name} 的 api {model.api} 不在 apis 里")
        return self

    def field(self, name: str) -> CredentialFieldDeclaration | None:
        return next((field for field in self.credential_fields if field.name == name), None)

    @property
    def secret_fields(self) -> frozenset[str]:
        return frozenset(
            field.name for field in self.credential_fields if field.type == FIELD_SECRET
        )


class Declarations(Mapping[str, ProviderDeclaration]):
    def __init__(self, declarations: Mapping[str, ProviderDeclaration]) -> None:
        self._by_name = dict(declarations)

    def __getitem__(self, name: str) -> ProviderDeclaration:
        return self._by_name[name]

    def __iter__(self) -> Iterator[str]:
        return iter(self._by_name)

    def __len__(self) -> int:
        return len(self._by_name)


def load_declarations(directory: Path = DECLARATIONS_DIR) -> Declarations:
    found: dict[str, ProviderDeclaration] = {}
    for path in sorted(directory.glob("*.yaml")):
        try:
            declaration = ProviderDeclaration.model_validate(
                yaml.safe_load(path.read_text(encoding="utf-8"))
            )
        except (OSError, yaml.YAMLError, ValidationError) as exc:
            raise RuntimeError(f"供应商声明 {path.name} 不合格：{exc}") from exc
        if declaration.name != path.stem:
            raise RuntimeError(
                f"供应商声明 {path.name} 的 name 是 {declaration.name}，要与文件名一致"
            )
        found[declaration.name] = declaration
    if not found:
        raise RuntimeError(f"{directory} 下没有供应商声明")
    return Declarations(found)


__all__ = [
    "API_KEY_FIELD",
    "BASE_URL_FIELD",
    "DECLARATIONS_DIR",
    "CredentialFieldDeclaration",
    "CredentialFieldName",
    "Declarations",
    "ModelDeclaration",
    "ProviderDeclaration",
    "load_declarations",
]
