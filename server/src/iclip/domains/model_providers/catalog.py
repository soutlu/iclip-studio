"""供应商声明：``declarations/`` 下一个供应商一个 YAML，随代码发布，启动时读取并校验，有错即启动失败。

声明说清一家供应商怎么接：密钥表单有哪些字段、哪些是机密、能不能自己加模型、内置哪些模型。自己加的
模型与声明里的模型按同一套规则校验（``ModelDeclaration``）。"""

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

from iclip.common.model_vocab import ModelApi, ThinkingEffort
from iclip.domains.model_providers.models import (
    FIELD_SECRET,
    MAX_LABEL_CHARS,
    MAX_MODEL_NAME_CHARS,
    PROVIDER_NAME_PATTERN,
    CredentialFieldType,
    ModelProperties,
    ModelType,
)

DECLARATIONS_DIR: Final = Path(__file__).resolve().parent / "declarations"

CredentialFieldName = Literal["api_key", "base_url"]
"""密钥字段只能是这两个：它们一一对应 Agent 引擎建模型时的 API Key 与接口地址，别的字段建模型用不上。"""

API_KEY_FIELD: Final = "api_key"
BASE_URL_FIELD: Final = "base_url"

Label = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_LABEL_CHARS)
]


class _Declaration(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class CredentialFieldDeclaration(_Declaration):
    """密钥表单的一个字段。``default`` 是不填时用的值，机密字段不能有。"""

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
    """一个模型：声明里内置的，或接入后自己加的。

    ``api`` 只有 llm 才有、且必须有；``thinking`` 是允许设的思考档位，不写就是不能设档位，也只有 llm
    才有；``context_size`` 可选。"""

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
                raise ValueError(f"llm 模型 {self.name} 要写 api（responses 或 chat）")
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
    """一家供应商怎么接。``name`` 与文件名一致；``pydantic_ai_provider`` 是 Agent 引擎认的 provider 名。"""

    name: Annotated[str, StringConstraints(pattern=PROVIDER_NAME_PATTERN.pattern)]
    label: Label
    pydantic_ai_provider: Annotated[str, StringConstraints(min_length=1)]
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
        keys = [(model.name, model.type) for model in self.models]
        if len(set(keys)) != len(keys):
            raise ValueError("models 里有重名的同类型模型")
        return self

    def field(self, name: str) -> CredentialFieldDeclaration | None:
        return next((field for field in self.credential_fields if field.name == name), None)

    @property
    def secret_fields(self) -> frozenset[str]:
        return frozenset(
            field.name for field in self.credential_fields if field.type == FIELD_SECRET
        )


class Declarations(Mapping[str, ProviderDeclaration]):
    """全部供应商声明，按声明名查；按文件名排序。"""

    def __init__(self, declarations: Mapping[str, ProviderDeclaration]) -> None:
        self._by_name = dict(declarations)

    def __getitem__(self, name: str) -> ProviderDeclaration:
        return self._by_name[name]

    def __iter__(self) -> Iterator[str]:
        return iter(self._by_name)

    def __len__(self) -> int:
        return len(self._by_name)


def load_declarations(directory: Path = DECLARATIONS_DIR) -> Declarations:
    """读 ``directory`` 下全部 ``*.yaml``。文件读不了、形状不对、``name`` 与文件名不一致、一个都没有，
    都抛 ``RuntimeError``，启动就此失败。"""

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
