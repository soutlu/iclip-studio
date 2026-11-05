from __future__ import annotations

from collections.abc import Mapping, Sequence

from pydantic import ValidationError

from agent_runtime.config.model_providers.catalog import (
    API_KEY_FIELD,
    BASE_URL_FIELD,
    ModelDeclaration,
    ProviderDeclaration,
)
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
    ProviderState,
)
from agent_runtime.errors import ValidationFailed
from agent_runtime.model_connections import ModelConnection
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
    kept = {name: value for name, value in fields.items() if value}
    for field in declaration.credential_fields:
        if field.required and field.name not in kept:
            raise ValidationFailed(f"请填写「{field.label}」")
    return kept


def new_fields(declaration: ProviderDeclaration, given: Mapping[str, str]) -> dict[str, str]:
    cleaned = _clean_given(declaration, given)
    for field in declaration.credential_fields:
        if field.name not in cleaned and field.default is not None:
            cleaned[field.name] = field.default
    return _complete(declaration, cleaned)


def merged_fields(
    declaration: ProviderDeclaration, current: Mapping[str, str], given: Mapping[str, str]
) -> dict[str, str]:
    return _complete(declaration, {**current, **_clean_given(declaration, given)})


def encrypt_fields(
    declaration: ProviderDeclaration, plain: Mapping[str, str], cipher: CredentialCipher
) -> dict[str, str]:
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
    secrets = declaration.secret_fields
    return {name: mask_secret(value) if name in secrets else value for name, value in plain.items()}


def merge_models(
    declaration: ProviderDeclaration, settings: Sequence[ModelSetting]
) -> tuple[ProviderModel, ...]:
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


def responses_connection(
    declaration: ProviderDeclaration,
    states: Sequence[ProviderState],
    model_name: str,
    cipher: CredentialCipher,
) -> ModelConnection | None:
    ordered = sorted(states, key=lambda state: (state.provider.created_at, state.provider.id))
    for state in ordered:
        provider = state.provider
        if not provider.enabled or provider.provider != declaration.name:
            continue
        model = find_model(merge_models(declaration, state.settings), model_name, "llm")
        if model is None or not model.enabled:
            continue
        credential = next(
            (one for one in state.credentials if one.id == provider.default_credential_id), None
        )
        if credential is None:
            continue
        fields = decrypt_fields(declaration, credential.fields, cipher)
        base_url = fields.get(BASE_URL_FIELD)
        if base_url is None:
            raise RuntimeError(
                f"{declaration.label}的密钥没有接口地址，不能直接调它的 Responses 接口"
            )
        return ModelConnection(
            responses_url=f"{base_url.rstrip('/')}/responses", api_key=fields[API_KEY_FIELD]
        )
    return None


def probe_model(models: Sequence[ProviderModel]) -> ProviderModel:
    found = next((one for one in models if one.type == "llm" and one.enabled), None)
    if found is None:
        raise ValidationFailed("先添加一个模型再试连")
    return found


def custom_model(
    declaration: ProviderDeclaration,
    *,
    name: str,
    model_type: ModelType,
    api: ModelApi | None,
    context_size: int | None,
    thinking: Sequence[ThinkingEffort],
) -> ModelDeclaration:
    try:
        model = ModelDeclaration(
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
    if model.api is not None and model.api not in declaration.apis:
        raise ValidationFailed(
            f"{declaration.label}的模型只能走 {'、'.join(declaration.apis)} 接口，不能走 {model.api}"
        )
    return model


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
    "responses_connection",
]
