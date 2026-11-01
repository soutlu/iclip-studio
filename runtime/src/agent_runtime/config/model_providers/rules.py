"""模型供应商的纯规则：整理名称、按声明校验与合并密钥字段、加解密与打码、合并模型列表、校验自己加的
模型。不合格是 ``ValidationFailed``，消息直接给人看，从不带字段的值。"""

from __future__ import annotations

from collections.abc import Mapping, Sequence

from pydantic import ValidationError

from agent_runtime.config.model_providers.catalog import ModelDeclaration, ProviderDeclaration
from agent_runtime.config.model_providers.models import (
    MAX_CREDENTIAL_NAME_CHARS,
    MAX_FIELD_VALUE_CHARS,
    MAX_LABEL_CHARS,
    PROVIDER_NAME_PATTERN,
    SOURCE_CUSTOM,
    SOURCE_DECLARED,
    ModelSetting,
    ModelType,
    ProviderModel,
)
from agent_runtime.errors import ValidationFailed
from agent_runtime.model_vocab import ModelApi, ThinkingEffort
from agent_runtime.secrets import CredentialCipher, mask_secret


def check_provider_name(name: str) -> str:
    if not PROVIDER_NAME_PATTERN.match(name):
        raise ValidationFailed("引用名只能用小写字母、数字和连字符，最多 64 个字符")
    return name


def _clean_text(value: str, *, what: str, limit: int) -> str:
    cleaned = value.strip()
    if not cleaned:
        raise ValidationFailed(f"请填写{what}")
    if len(cleaned) > limit:
        raise ValidationFailed(f"{what}最多 {limit} 个字")
    return cleaned


def clean_label(label: str) -> str:
    return _clean_text(label, what="显示名", limit=MAX_LABEL_CHARS)


def clean_credential_name(name: str) -> str:
    return _clean_text(name, what="密钥名称", limit=MAX_CREDENTIAL_NAME_CHARS)


def _clean_given(declaration: ProviderDeclaration, given: Mapping[str, str]) -> dict[str, str]:
    """去掉首尾空白；不认识的字段、超长的值不收。空串留着，交给必填检查。"""

    cleaned: dict[str, str] = {}
    for name, value in given.items():
        field = declaration.field(name)
        if field is None:
            raise ValidationFailed(f"{declaration.label}的密钥没有 {name} 这个字段")
        stripped = value.strip()
        if len(stripped) > MAX_FIELD_VALUE_CHARS:
            raise ValidationFailed(f"「{field.label}」最多 {MAX_FIELD_VALUE_CHARS} 个字符")
        cleaned[name] = stripped
    return cleaned


def _complete(declaration: ProviderDeclaration, fields: Mapping[str, str]) -> dict[str, str]:
    """去掉空值，查必填项。"""

    kept = {name: value for name, value in fields.items() if value}
    for field in declaration.credential_fields:
        if field.required and field.name not in kept:
            raise ValidationFailed(f"请填写「{field.label}」")
    return kept


def new_fields(declaration: ProviderDeclaration, given: Mapping[str, str]) -> dict[str, str]:
    """新建一把密钥的明文字段：没给的字段用声明里的 ``default``。"""

    cleaned = _clean_given(declaration, given)
    for field in declaration.credential_fields:
        if field.name not in cleaned and field.default is not None:
            cleaned[field.name] = field.default
    return _complete(declaration, cleaned)


def merged_fields(
    declaration: ProviderDeclaration, current: Mapping[str, str], given: Mapping[str, str]
) -> dict[str, str]:
    """改一把密钥：给了的字段替换，没给的（包括机密字段）保持原值。给打码后的值不会被当成「不改」，
    它就是新值。"""

    return _complete(declaration, {**current, **_clean_given(declaration, given)})


def encrypt_fields(
    declaration: ProviderDeclaration, plain: Mapping[str, str], cipher: CredentialCipher
) -> dict[str, str]:
    """明文换成存储形态：机密字段加密，其余原样。"""

    secrets = declaration.secret_fields
    return {
        name: cipher.encrypt(value) if name in secrets else value for name, value in plain.items()
    }


def decrypt_fields(
    declaration: ProviderDeclaration, stored: Mapping[str, str], cipher: CredentialCipher
) -> dict[str, str]:
    secrets = declaration.secret_fields
    return {
        name: cipher.decrypt(value) if name in secrets else value for name, value in stored.items()
    }


def masked_fields(declaration: ProviderDeclaration, plain: Mapping[str, str]) -> dict[str, str]:
    """返回给人看的字段：机密字段打码，其余原样。"""

    secrets = declaration.secret_fields
    return {name: mask_secret(value) if name in secrets else value for name, value in plain.items()}


def merge_models(
    declaration: ProviderDeclaration, settings: Sequence[ModelSetting]
) -> tuple[ProviderModel, ...]:
    """模型列表：声明里的模型（默认启用，表里记了停用的显示为停用）在前，自己加的在后。"""

    disabled = {
        (setting.name, setting.type)
        for setting in settings
        if setting.source == SOURCE_DECLARED and not setting.enabled
    }
    declared = tuple(
        ProviderModel(
            name=model.name,
            type=model.type,
            source=SOURCE_DECLARED,
            properties=model.properties(),
            enabled=(model.name, model.type) not in disabled,
        )
        for model in declaration.models
    )
    custom: list[ProviderModel] = []
    for setting in settings:
        if setting.source != SOURCE_CUSTOM:
            continue
        if setting.properties is None:
            raise RuntimeError(f"自己加的模型 {setting.name} 在表里没有属性")
        custom.append(
            ProviderModel(
                name=setting.name,
                type=setting.type,
                source=SOURCE_CUSTOM,
                properties=setting.properties,
                enabled=setting.enabled,
            )
        )
    return (*declared, *custom)


def find_model(
    models: Sequence[ProviderModel], name: str, model_type: ModelType
) -> ProviderModel | None:
    return next((one for one in models if one.name == name and one.type == model_type), None)


def probe_model(models: Sequence[ProviderModel]) -> ProviderModel:
    """试连用的模型：第一个启用的 llm 模型。"""

    found = next((one for one in models if one.type == "llm" and one.enabled), None)
    if found is None:
        raise ValidationFailed("这个供应商没有启用的 llm 模型，没法试连")
    return found


def custom_model(
    *,
    name: str,
    model_type: ModelType,
    api: ModelApi | None,
    context_size: int | None,
    thinking: Sequence[ThinkingEffort],
) -> ModelDeclaration:
    """按声明里模型的同一套规则校验一个自己加的模型。"""

    try:
        return ModelDeclaration(
            name=name,
            type=model_type,
            api=api,
            context_size=context_size,
            thinking=tuple(thinking),
        )
    except ValidationError as exc:
        first = exc.errors()[0]
        location = ".".join(str(part) for part in first["loc"])
        message = str(first["msg"]).removeprefix("Value error, ")
        raise ValidationFailed(f"{location}: {message}" if location else message) from None


__all__ = [
    "check_provider_name",
    "clean_credential_name",
    "clean_label",
    "custom_model",
    "decrypt_fields",
    "encrypt_fields",
    "find_model",
    "masked_fields",
    "merge_models",
    "merged_fields",
    "new_fields",
    "probe_model",
]
