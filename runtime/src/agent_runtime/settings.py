from __future__ import annotations

import hmac
import os
import tempfile
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Annotated, Any, Final, Literal

from cryptography.fernet import Fernet
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    HttpUrl,
    ImportString,
    StringConstraints,
    field_validator,
    model_validator,
)
from pydantic_settings import (
    BaseSettings,
    PydanticBaseSettingsSource,
    SettingsConfigDict,
    YamlConfigSettingsSource,
)

DATABASE_URL_ENV: Final = "DATABASE_URL"

CREDENTIAL_ENCRYPTION_KEYS_ENV: Final = "CREDENTIAL_ENCRYPTION_KEYS"

DEFAULT_SKILL_CACHE_DIRNAME: Final = "agent-runtime-skills"

MIN_APP_KEY_LENGTH: Final = 32

DEFAULT_HOOK_TIMEOUT_SECONDS: Final = 10.0

RequiredEnv = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]

AppId = Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_-]*$", max_length=64)]

EnvName = Annotated[str, StringConstraints(pattern=r"^[A-Z_][A-Z0-9_]*$")]


class ConfigSection(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class HooksSection(ConfigSection):
    token_env: EnvName | None = None
    gate: HttpUrl | None
    run_started: HttpUrl | None
    turn_started: HttpUrl | None
    timeout_seconds: float = Field(default=DEFAULT_HOOK_TIMEOUT_SECONDS, gt=0)

    @model_validator(mode="after")
    def _token_when_any_hook(self) -> HooksSection:
        if self.token_env is None and any(
            url is not None for url in (self.gate, self.run_started, self.turn_started)
        ):
            raise ValueError("配置了回调地址就必须给 token_env")
        return self


class AppSection(ConfigSection):
    key_env: EnvName
    admin: bool = False
    hooks: HooksSection


class AgentRunsSection(ConfigSection):
    heartbeat_seconds: int = Field(default=10, gt=0)
    lease_seconds: int = Field(default=30, gt=0)
    sweep_seconds: int = Field(default=15, gt=0)
    max_attempts: int = Field(default=2, ge=1)
    max_snapshots_per_run: int = Field(default=3, ge=1)
    assembly_cache_size: int = Field(default=64, ge=1)
    skill_cache_dir: Path = Field(
        default_factory=lambda: Path(tempfile.gettempdir()) / DEFAULT_SKILL_CACHE_DIRNAME
    )

    @model_validator(mode="after")
    def _lease_outlasts_a_heartbeat(self) -> AgentRunsSection:
        if self.lease_seconds <= self.heartbeat_seconds:
            raise ValueError("lease_seconds 必须大于 heartbeat_seconds")
        return self


class CompactionSection(ConfigSection):
    max_fraction: float = Field(default=0.85, gt=0, lt=1)
    keep_messages: int = Field(default=20, ge=1)


class OpsSection(ConfigSection):
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    log_format: Literal["console", "json"] = "console"


class PluginsSection(ConfigSection):
    factory: ImportString[Callable[..., Any]]

    config: dict[str, Any] = Field(default_factory=dict[str, Any])


class ServiceConfig(BaseSettings):
    model_config = SettingsConfigDict(frozen=True, extra="forbid")

    apps: dict[AppId, AppSection] = Field(min_length=1)
    plugins: PluginsSection | None = None
    agent_runs: AgentRunsSection = AgentRunsSection()
    compaction: CompactionSection = CompactionSection()
    ops: OpsSection = OpsSection()

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls: type[BaseSettings],
        init_settings: PydanticBaseSettingsSource,
        env_settings: PydanticBaseSettingsSource,
        dotenv_settings: PydanticBaseSettingsSource,
        file_secret_settings: PydanticBaseSettingsSource,
    ) -> tuple[PydanticBaseSettingsSource, ...]:
        return (init_settings,)


def load_config(path: Path) -> ServiceConfig:
    if not path.is_file():
        raise FileNotFoundError(f"配置文件不存在: {path}")
    data = YamlConfigSettingsSource(ServiceConfig, yaml_file=path)()
    if not data:
        raise ValueError(f"配置文件为空或不是 mapping: {path}")
    return ServiceConfig(**data)


class EnvSettings(BaseSettings):
    model_config = SettingsConfigDict(frozen=True, extra="ignore", hide_input_in_errors=True)


class CoreEnv(EnvSettings):
    database_url: RequiredEnv = Field(validation_alias=DATABASE_URL_ENV)

    @field_validator("database_url")
    @classmethod
    def _must_be_asyncpg(cls, value: str) -> str:
        if not value.startswith("postgresql+asyncpg://"):
            raise ValueError("必须是 postgresql+asyncpg:// 连接串")
        return value


class CredentialKeysEnv(EnvSettings):
    keys: RequiredEnv = Field(validation_alias=CREDENTIAL_ENCRYPTION_KEYS_ENV)

    @field_validator("keys")
    @classmethod
    def _fernet_keys(cls, value: str) -> str:
        parts = [part.strip() for part in value.split(",")]
        for position, part in enumerate(parts, start=1):
            if not part:
                raise ValueError(f"第 {position} 个 key 是空的")
            try:
                Fernet(part)
            except ValueError:
                raise ValueError(
                    f"第 {position} 个 key 不是合法的 Fernet key（32 字节的 urlsafe base64），"
                    "用 Fernet.generate_key() 生成"
                ) from None
        return ",".join(parts)

    @property
    def key_list(self) -> tuple[str, ...]:
        return tuple(self.keys.split(","))


@dataclass(frozen=True, slots=True)
class ResolvedHooks:
    token: str = field(repr=False)
    gate: str | None
    run_started: str | None
    turn_started: str | None
    timeout_seconds: float = DEFAULT_HOOK_TIMEOUT_SECONDS


@dataclass(frozen=True, slots=True)
class ResolvedApp:
    id: str
    key: str
    admin: bool
    hooks: ResolvedHooks | None = None


@dataclass(frozen=True, slots=True)
class RuntimeSettings:
    database_url: str
    credential_encryption_keys: tuple[str, ...]
    apps: tuple[ResolvedApp, ...]
    agent_runs: AgentRunsSection
    compaction: CompactionSection
    log_level: str
    log_format: Literal["console", "json"]


def _from_env[EnvT: EnvSettings](cls: type[EnvT]) -> EnvT:
    return cls()  # pyright: ignore[reportCallIssue]


def _resolve_apps(apps: dict[str, AppSection]) -> tuple[ResolvedApp, ...]:
    resolved: list[ResolvedApp] = []
    for app_id, section in apps.items():
        key = os.environ.get(section.key_env, "").strip()
        if not key:
            raise RuntimeError(f"应用 {app_id} 的密钥环境变量 {section.key_env} 没有设置")
        if len(key) < MIN_APP_KEY_LENGTH:
            raise RuntimeError(
                f"应用 {app_id} 的密钥（{section.key_env}）长度必须 ≥ {MIN_APP_KEY_LENGTH} 字符"
            )
        for other in resolved:
            if hmac.compare_digest(other.key.encode(), key.encode()):
                raise RuntimeError(
                    f"应用 {other.id} 与 {app_id} 用了同一把密钥，每个应用要各用各的"
                )
        resolved.append(
            ResolvedApp(
                id=app_id, key=key, admin=section.admin, hooks=_resolve_hooks(app_id, section.hooks)
            )
        )
    return tuple(resolved)


def _resolve_hooks(app_id: str, section: HooksSection) -> ResolvedHooks | None:
    urls = (section.gate, section.run_started, section.turn_started)
    if all(url is None for url in urls):
        return None
    if section.token_env is None:
        raise RuntimeError(f"应用 {app_id} 配置了回调地址却没有 token_env")
    token = os.environ.get(section.token_env, "").strip()
    if not token:
        raise RuntimeError(f"应用 {app_id} 的回调令牌环境变量 {section.token_env} 没有设置")
    if len(token) < MIN_APP_KEY_LENGTH:
        raise RuntimeError(
            f"应用 {app_id} 的回调令牌（{section.token_env}）长度必须 ≥ {MIN_APP_KEY_LENGTH} 字符"
        )
    gate, run_started, turn_started = (None if url is None else str(url) for url in urls)
    return ResolvedHooks(
        token=token,
        gate=gate,
        run_started=run_started,
        turn_started=turn_started,
        timeout_seconds=section.timeout_seconds,
    )


def resolve_settings(config: ServiceConfig) -> RuntimeSettings:
    return RuntimeSettings(
        database_url=_from_env(CoreEnv).database_url,
        credential_encryption_keys=_from_env(CredentialKeysEnv).key_list,
        apps=_resolve_apps(config.apps),
        agent_runs=config.agent_runs,
        compaction=config.compaction,
        log_level=config.ops.log_level,
        log_format=config.ops.log_format,
    )


__all__ = [
    "CREDENTIAL_ENCRYPTION_KEYS_ENV",
    "DATABASE_URL_ENV",
    "DEFAULT_HOOK_TIMEOUT_SECONDS",
    "MIN_APP_KEY_LENGTH",
    "AgentRunsSection",
    "AppSection",
    "CompactionSection",
    "CredentialKeysEnv",
    "HooksSection",
    "OpsSection",
    "PluginsSection",
    "ResolvedApp",
    "ResolvedHooks",
    "RuntimeSettings",
    "ServiceConfig",
    "load_config",
    "resolve_settings",
]
