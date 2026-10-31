"""运行时服务的配置：YAML 文件给运行参数、接入的应用名单与插件包，环境变量给连接串与机密。

照后端的做法分两步：``load_config`` 只读 YAML（不看环境变量），``resolve_settings`` 再读环境变量、
连同各应用的密钥一起校验，交回服务装配用的 ``RuntimeSettings``。缺了或格式不对都在启动时报错，
报错不带机密本身。
"""

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
"""``agent_runs.skill_cache_dir`` 不写时，技能缓存放在系统临时目录下的这个子目录。"""

MIN_APP_KEY_LENGTH: Final = 32
"""应用密钥与回调令牌的最短长度，与后端会话密钥同一个下限。"""

DEFAULT_HOOK_TIMEOUT_SECONDS: Final = 10.0
"""回调应用时等它答复的上限。"""

RequiredEnv = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]

AppId = Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_-]*$", max_length=64)]
"""应用标识：小写字母开头，只含小写字母、数字、``-`` 与 ``_``。"""

EnvName = Annotated[str, StringConstraints(pattern=r"^[A-Z_][A-Z0-9_]*$")]


class ConfigSection(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class HooksSection(ConfigSection):
    """运行时回调这个应用的三个地址与回调时带的令牌。

    三个地址的键都必须写，``null`` 表示没有这个回调：接入一个应用时得逐个想清楚要不要。任一地址有值就
    必须给 ``token_env``，运行时把那个环境变量里的令牌放在 ``Authorization: Bearer`` 里。"""

    token_env: EnvName | None = None
    gate: HttpUrl | None
    """开跑检查：每次运行开跑前等它答 2xx。没答复（超时、连不上）或答 502/503/504 时退避重试约 30 秒，
    还没放行、或答了别的非 2xx，这次运行失败，原因记在消息行上。"""
    run_started: HttpUrl | None
    """每次顶层运行挂上租约后等它答完再往下跑；失败只记日志。"""
    turn_started: HttpUrl | None
    """每一轮开场在后台调一次；失败只记日志。"""
    timeout_seconds: float = Field(default=DEFAULT_HOOK_TIMEOUT_SECONDS, gt=0)

    @model_validator(mode="after")
    def _token_when_any_hook(self) -> HooksSection:
        if self.token_env is None and any(
            url is not None for url in (self.gate, self.run_started, self.turn_started)
        ):
            raise ValueError("配置了回调地址就必须给 token_env")
        return self


class AppSection(ConfigSection):
    """一个接入的应用：密钥放在哪个环境变量里，能不能用 ``/v1/admin`` 管理接口，运行时回调它的哪些地址。"""

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
    """装配好的 agent 在每个进程里最多缓存几份。"""
    skill_cache_dir: Path = Field(
        default_factory=lambda: Path(tempfile.gettempdir()) / DEFAULT_SKILL_CACHE_DIRNAME
    )
    """技能版本按内容 hash 写进的本机目录。"""

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
    """接哪个插件包。"""

    factory: ImportString[Callable[..., Any]]
    """插件包的入口 ``模块:可调用对象``，形状见 ``agent_runtime.plugins.base.PluginFactory``；读配置时
    就 import，写错了启动失败。"""

    config: dict[str, Any] = Field(default_factory=dict[str, Any])
    """原样交给入口，运行时不解读；机密只写放它的环境变量名。"""


class ServiceConfig(BaseSettings):
    """YAML 配置文件的形状；只从文件读，不看环境变量。"""

    model_config = SettingsConfigDict(frozen=True, extra="forbid")

    apps: dict[AppId, AppSection] = Field(min_length=1)
    plugins: PluginsSection | None = None
    """不写就没有插件：插件登记表是空的。"""
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
    """读 YAML 配置文件；文件不存在、为空或不是 mapping 都报错。"""

    if not path.is_file():
        raise FileNotFoundError(f"配置文件不存在: {path}")
    data = YamlConfigSettingsSource(ServiceConfig, yaml_file=path)()
    if not data:
        raise ValueError(f"配置文件为空或不是 mapping: {path}")
    return ServiceConfig(**data)


class EnvSettings(BaseSettings):
    # 环境变量里是连接串与机密：pydantic 的报错默认带原值，这里不带。
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
    """模型供应商密钥里机密字段的加密钥匙：逗号分隔的 Fernet key，第一个加密，全部用来解密。"""

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
                # 报错不带 key 本身：它是机密。
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
    """一个应用的回调：令牌与三个地址，地址为空就是没有这个回调。"""

    token: str = field(repr=False)
    gate: str | None
    run_started: str | None
    turn_started: str | None
    timeout_seconds: float = DEFAULT_HOOK_TIMEOUT_SECONDS


@dataclass(frozen=True, slots=True)
class ResolvedApp:
    """一个接入的应用：标识、它的密钥、有没有管理权限与它的回调（三个地址都为空时是 ``None``）。"""

    id: str
    key: str
    admin: bool
    hooks: ResolvedHooks | None = None


@dataclass(frozen=True, slots=True)
class RuntimeSettings:
    database_url: str
    credential_encryption_keys: tuple[str, ...]
    """模型供应商密钥的加密钥匙，第一个加密，全部用来解密。"""
    apps: tuple[ResolvedApp, ...]
    agent_runs: AgentRunsSection
    compaction: CompactionSection
    log_level: str
    log_format: Literal["console", "json"]


def _from_env[EnvT: EnvSettings](cls: type[EnvT]) -> EnvT:
    return cls()  # pyright: ignore[reportCallIssue]


def _resolve_apps(apps: dict[str, AppSection]) -> tuple[ResolvedApp, ...]:
    """按各应用的 ``key_env`` 读出密钥；缺了、太短、两个应用同一把都启动失败。"""

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
    """按 ``token_env`` 读出回调令牌；三个地址都为空时没有回调，令牌也不读。"""

    urls = (section.gate, section.run_started, section.turn_started)
    if all(url is None for url in urls):
        return None
    if section.token_env is None:
        # 配置校验已拦住这种写法；直接建 HooksSection 绕过校验时照样报错。
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
    """读环境变量，连同 YAML 配置合成服务装配用的设置。"""

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
