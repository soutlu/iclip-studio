from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Any, Final, Literal
from urllib.parse import urlsplit

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
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

from iclip.common.generation_vocab import VideoEnhanceResolution

_MIN_SECRET_LENGTH = 32

RequiredEnv = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]

OptionalEnv = Annotated[str, StringConstraints(strip_whitespace=True)]

SSO_BASE_URL_ENV: Final = "SSO_BASE_URL"

DEFAULT_SSO_OAUTH_NAME: Final = "sso"

OSS_BUCKET_ENV: Final = "OSS_BUCKET"

VIDEO_SUBMIT_URL_ENV: Final = "VIDEO_SUBMIT_URL"

VIDEO_ENHANCE_SUBMIT_URL_ENV: Final = "VIDEO_ENHANCE_SUBMIT_URL"

QWEN_API_KEY_ENV: Final = "QWEN_API_KEY"

VIDEO_UNDERSTANDING_URL_ENV: Final = "VIDEO_UNDERSTANDING_URL"

PRODUCT_CATALOG_DATABASE_URL_ENV: Final = "PRODUCT_CATALOG_DATABASE_URL"

WHOLE_FILM_RENDER_URL_ENV: Final = "WHOLE_FILM_RENDER_URL"

RUNTIME_INTERNAL_TOKEN_ENV: Final = "RUNTIME_INTERNAL_TOKEN"

RUNTIME_URL_ENV: Final = "RUNTIME_URL"

RUNTIME_APP_KEY_ENV: Final = "RUNTIME_APP_KEY"

_MOVED_TO_RUNTIME: Final[Mapping[str, str]] = {
    "agent_runs": "agent_runs",
    "conversations": "compaction（原 conversations.compaction）",
    "video": "plugins.config.video",
}
"""后端不再认、搬到运行时配置（``configs/runtime.yaml``）的段：后端的段名 → 运行时配置里的位置。"""


class ConfigSection(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class EnvSettings(BaseSettings):
    # 环境变量里是连接串与机密：pydantic 的报错默认带原值，这里不带。
    model_config = SettingsConfigDict(frozen=True, extra="ignore", hide_input_in_errors=True)


class CoreEnv(EnvSettings):
    database_url: RequiredEnv = Field(validation_alias="DATABASE_URL")
    auth_secret: RequiredEnv = Field(validation_alias="AUTH_SECRET")

    @field_validator("database_url")
    @classmethod
    def _must_be_asyncpg(cls, value: str) -> str:
        if not value.startswith("postgresql+asyncpg://"):
            raise ValueError("必须是 postgresql+asyncpg:// 连接串")
        return value

    @field_validator("auth_secret")
    @classmethod
    def _long_enough(cls, value: str) -> str:
        if len(value) < _MIN_SECRET_LENGTH:
            raise ValueError(f"长度必须 ≥ {_MIN_SECRET_LENGTH} 字符")
        return value


class SsoEnv(EnvSettings):
    base_url: RequiredEnv = Field(validation_alias=SSO_BASE_URL_ENV)
    redirect_url: RequiredEnv = Field(validation_alias="SSO_REDIRECT_URL")
    pms_base_url: OptionalEnv = Field("", validation_alias="PMS_BASE_URL")
    root_email: OptionalEnv = Field("", validation_alias="ROOT_EMAIL")
    oauth_name: OptionalEnv = Field("", validation_alias="SSO_OAUTH_NAME")


class ObjectStoreEnv(EnvSettings):
    bucket: RequiredEnv = Field(validation_alias=OSS_BUCKET_ENV)
    endpoint: RequiredEnv = Field(validation_alias="OSS_ENDPOINT")
    access_key_id: RequiredEnv = Field(validation_alias="OSS_ACCESS_KEY_ID")
    access_key_secret: RequiredEnv = Field(validation_alias="OSS_ACCESS_KEY_SECRET")
    public_url_base: RequiredEnv = Field(validation_alias="OSS_PUBLIC_URL_BASE")
    # 阿里云的内网 endpoint 只在与桶同地域的 ECS 或 VPC 内可用。
    internal_endpoint: OptionalEnv = Field("", validation_alias="OSS_INTERNAL_ENDPOINT")


class MediaGenerationEnv(EnvSettings):
    video_submit_url: RequiredEnv = Field(validation_alias=VIDEO_SUBMIT_URL_ENV)
    video_status_base_url: RequiredEnv = Field(validation_alias="VIDEO_STATUS_BASE_URL")
    video_api_key: RequiredEnv = Field(validation_alias="VIDEO_API_KEY")
    image_api_base: RequiredEnv = Field(validation_alias="IMAGE_API_BASE")
    # 高清版（超分）的完整提交地址；查询地址与 key 同出片。留空就是没开通。
    video_enhance_submit_url: OptionalEnv = Field("", validation_alias=VIDEO_ENHANCE_SUBMIT_URL_ENV)


class QwenEnv(EnvSettings):
    api_key: RequiredEnv = Field(validation_alias=QWEN_API_KEY_ENV)


class VideoUnderstandingEnv(EnvSettings):
    url: RequiredEnv = Field(validation_alias=VIDEO_UNDERSTANDING_URL_ENV)
    api_key: RequiredEnv = Field(validation_alias="VIDEO_UNDERSTANDING_API_KEY")


class ProductCatalogEnv(EnvSettings):
    database_url: RequiredEnv = Field(validation_alias=PRODUCT_CATALOG_DATABASE_URL_ENV)


class WholeFilmRenderEnv(EnvSettings):
    url: RequiredEnv = Field(validation_alias=WHOLE_FILM_RENDER_URL_ENV)
    """成片渲染服务的内网根地址（compose 里的服务名），只给服务端用。"""

    @field_validator("url")
    @classmethod
    def _http_url(cls, value: str) -> str:
        parts = urlsplit(value)
        if parts.scheme not in {"http", "https"} or not parts.netloc:
            raise ValueError(f"{WHOLE_FILM_RENDER_URL_ENV} 必须是 http:// 或 https:// 地址")
        return value.rstrip("/")


class RuntimeInternalEnv(EnvSettings):
    """运行时服务调后端内部接口（回调与插件服务）时带的令牌；与运行时给应用 ``video`` 配的
    ``hooks.token_env`` 是同一个值。"""

    token: RequiredEnv = Field(validation_alias=RUNTIME_INTERNAL_TOKEN_ENV)

    @field_validator("token")
    @classmethod
    def _long_enough(cls, value: str) -> str:
        if len(value) < _MIN_SECRET_LENGTH:
            raise ValueError(f"长度必须 ≥ {_MIN_SECRET_LENGTH} 字符")
        return value


class RuntimeServiceEnv(EnvSettings):
    """运行时服务的地址与后端在它那里的应用密钥；密钥与运行时配置里应用 ``video`` 的 ``key_env`` 指向的
    值相同。"""

    url: RequiredEnv = Field(validation_alias=RUNTIME_URL_ENV)
    """运行时服务的内网根地址（不含 ``/v1``），只给服务端用。"""
    app_key: RequiredEnv = Field(validation_alias=RUNTIME_APP_KEY_ENV)

    @field_validator("url")
    @classmethod
    def _http_url(cls, value: str) -> str:
        parts = urlsplit(value)
        if parts.scheme not in {"http", "https"} or not parts.netloc:
            raise ValueError(f"{RUNTIME_URL_ENV} 必须是 http:// 或 https:// 地址")
        return value.rstrip("/")

    @field_validator("app_key")
    @classmethod
    def _long_enough(cls, value: str) -> str:
        if len(value) < _MIN_SECRET_LENGTH:
            raise ValueError(f"长度必须 ≥ {_MIN_SECRET_LENGTH} 字符")
        return value


class AppSection(ConfigSection):
    name: str


class DbSection(ConfigSection):
    db_schema: str = Field("iclip", alias="schema")

    model_config = ConfigDict(frozen=True, extra="forbid", populate_by_name=True)

    @field_validator("db_schema")
    @classmethod
    def _schema_is_safe(cls, value: str) -> str:
        if not value.isidentifier():
            raise ValueError("schema 必须是合法标识符")
        return value


class SecuritySection(ConfigSection):
    session_lifetime_seconds: int = 604800
    cookie_secure: bool = False
    cors_allow_origins: tuple[str, ...] = ()

    @field_validator("cors_allow_origins")
    @classmethod
    def _no_wildcard(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        if "*" in value:
            raise ValueError('cors_allow_origins 禁止 "*"，必须列出精确 origin')
        return value


class SsoSection(ConfigSection):
    app_name: str


class VideoEnhanceSection(ConfigSection):
    """高清版（超分）：用哪个模型、提到哪几档（从高到低，界面按这个顺序列）、帧率。"""

    model: str = Field(min_length=1)
    resolutions: tuple[VideoEnhanceResolution, ...] = Field(min_length=1)
    fps: int | None = Field(default=None, ge=15, le=60)
    """目标帧率；不写就不插帧，保持原片帧率。"""

    @field_validator("resolutions")
    @classmethod
    def _distinct(
        cls, value: tuple[VideoEnhanceResolution, ...]
    ) -> tuple[VideoEnhanceResolution, ...]:
        if len(set(value)) != len(value):
            raise ValueError("enhance.resolutions 不能重复")
        return value


class VideoGenerationSection(ConfigSection):
    model: str
    allowed_models: tuple[
        Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)], ...
    ] = Field(min_length=1)
    enhance: VideoEnhanceSection | None = None

    @model_validator(mode="after")
    def _default_model_is_allowed(self) -> VideoGenerationSection:
        if self.model not in self.allowed_models:
            raise ValueError("video.model 必须包含在 video.allowed_models 中")
        return self


class ImageModelSection(ConfigSection):
    route: str = Field(min_length=1)
    concurrency: int = Field(gt=0)
    text_to_image_task: str | None = Field(default=None, min_length=1)
    image_edit_task: str | None = Field(default=None, min_length=1)


class ImageGenerationSection(ConfigSection):
    env: Literal["prod", "uat", "test"]
    text_to_image_task: str = Field(min_length=1)
    image_edit_task: str = Field(min_length=1)
    default: str
    models: dict[str, ImageModelSection] = Field(min_length=1)

    @model_validator(mode="after")
    def _default_is_declared(self) -> ImageGenerationSection:
        if self.default not in self.models:
            raise ValueError("image.default 必须是 image.models 里的一个键")
        return self


class QwenServiceSection(ConfigSection):
    url: str = Field(min_length=1)
    concurrency: int = Field(gt=0)
    timeout_seconds: float = Field(gt=0)


class SubtitleSection(QwenServiceSection):
    concurrency: int = Field(default=4, gt=0)
    timeout_seconds: float = Field(default=120.0, gt=0)


class MusicSection(QwenServiceSection):
    concurrency: int = Field(default=2, gt=0)
    timeout_seconds: float = Field(default=300.0, gt=0)


class MediaGenerationSection(ConfigSection):
    video: VideoGenerationSection
    image: ImageGenerationSection
    poll_interval_seconds: int = Field(default=5, ge=1)
    job_timeout_seconds: int = Field(default=3600, ge=1)
    compose_concurrency: int | None = Field(default=None, ge=1)
    subtitle: SubtitleSection | None = None
    music: MusicSection | None = None


class IclipStudioSection(ConfigSection):
    breakdown_model: str
    breakdown_concurrency: int | None = Field(default=None, ge=1)


class ShotVideoSection(ConfigSection):
    """写了就给运行时的 ``shot_video`` 插件挂取帧拼板、切格与出图的内部接口；出图的重试策略在运行时配置的
    ``plugins.config.shot_video``。"""


class OpsSection(ConfigSection):
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    log_format: Literal["console", "json"] = "console"


class RuntimeConfig(BaseSettings):
    model_config = SettingsConfigDict(frozen=True, extra="forbid")

    app: AppSection
    db: DbSection
    security: SecuritySection
    sso: SsoSection
    media_generation: MediaGenerationSection | None = None
    shot_video: ShotVideoSection | None = None
    iclip_studio: IclipStudioSection | None = None
    ops: OpsSection = OpsSection()

    @model_validator(mode="before")
    @classmethod
    def _no_sections_moved_to_the_runtime(cls, data: Any) -> Any:
        """搬去运行时的段还写着时点名它和新位置；不然只有一句「Extra inputs are not permitted」。"""

        if not isinstance(data, Mapping):
            return data
        sections: Mapping[str, Any] = data  # pyright: ignore[reportUnknownVariableType]
        for name, moved_to in _MOVED_TO_RUNTIME.items():
            if name in sections:
                raise ValueError(
                    f"{name} 段已搬到运行时服务的配置（configs/runtime.yaml 的 {moved_to}），"
                    "从后端的配置文件里删掉它"
                )
        shot_video = sections.get("shot_video")
        if isinstance(shot_video, Mapping) and shot_video:
            raise ValueError(
                "shot_video 段的出图重试策略已搬到运行时服务的配置（configs/runtime.yaml 的 "
                "plugins.config.shot_video），后端这一段只留 shot_video: {}"
            )
        return data

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


def load_runtime_config(path: Path) -> RuntimeConfig:
    if not path.is_file():
        raise FileNotFoundError(f"配置文件不存在: {path}")
    source = YamlConfigSettingsSource(RuntimeConfig, yaml_file=path)
    data = source()
    if not data:
        raise ValueError(f"配置文件为空或不是 mapping: {path}")
    return RuntimeConfig(**data)


@dataclass(frozen=True, slots=True)
class ResolvedSecurity:
    secret: str
    lifetime_seconds: int
    cookie_secure: bool
    cors_allow_origins: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class ResolvedSso:
    base_url: str
    app_name: str
    redirect_url: str
    pms_base_url: str | None
    root_email: str | None
    oauth_name: str


@dataclass(frozen=True, slots=True)
class ResolvedImageModel:
    name: str
    api_base: str
    concurrency: int
    text_to_image_task: str | None = None
    image_edit_task: str | None = None


@dataclass(frozen=True, slots=True)
class ResolvedQwenService:
    url: str
    api_key: str
    concurrency: int
    timeout_seconds: float


@dataclass(frozen=True, slots=True)
class ResolvedVideoEnhance:
    submit_url: str
    model: str
    resolutions: tuple[VideoEnhanceResolution, ...]
    fps: int | None


@dataclass(frozen=True, slots=True)
class ResolvedMediaGeneration:
    video_submit_url: str
    video_status_base_url: str
    video_api_key: str
    video_model: str
    video_allowed_models: tuple[str, ...]
    video_enhance: ResolvedVideoEnhance | None
    """高清版；为 None 时提交端点答「没有开通」。"""
    image_models: tuple[ResolvedImageModel, ...]
    image_default_model: str
    image_env: str
    image_text_to_image_task: str
    image_edit_task: str
    poll_interval_seconds: int
    job_timeout_seconds: int
    compose_concurrency: int | None
    subtitle: ResolvedQwenService | None
    music: ResolvedQwenService | None


@dataclass(frozen=True, slots=True)
class ResolvedIclipStudio:
    breakdown_url: str
    breakdown_api_key: str
    breakdown_model: str
    breakdown_concurrency: int | None


@dataclass(frozen=True, slots=True)
class ResolvedProductCatalog:
    database_url: str


@dataclass(frozen=True, slots=True)
class ResolvedWholeFilmRender:
    url: str


@dataclass(frozen=True, slots=True)
class ResolvedRuntimeService:
    url: str
    app_key: str


@dataclass(frozen=True, slots=True)
class ResolvedSettings:
    app_name: str
    database_url: str
    db_schema: str
    security: ResolvedSecurity
    sso: ResolvedSso | None
    object_store: ObjectStoreEnv | None
    media_generation: ResolvedMediaGeneration | None
    shot_video: bool
    """配了 ``shot_video`` 段：要给运行时挂取帧拼板、切格与出图的内部接口。"""
    iclip_studio: ResolvedIclipStudio | None
    product_catalog: ResolvedProductCatalog | None
    whole_film_render: ResolvedWholeFilmRender | None
    """成片导出用的渲染服务；为 None 时导出端点答「没有开通」。"""
    runtime_internal_token: str
    """运行时服务调内部接口带的令牌；必填。"""
    runtime_service: ResolvedRuntimeService
    """后端经它的 HTTP 接口调运行时服务；必填。"""
    log_level: str
    log_format: Literal["console", "json"]

    @property
    def shot_tools_missing(self) -> tuple[str, ...]:
        if not self.shot_video:
            return ()
        return tuple(
            name
            for name, present in (
                (VIDEO_SUBMIT_URL_ENV, self.media_generation is not None),
                (OSS_BUCKET_ENV, self.object_store is not None),
            )
            if not present
        )

    @property
    def shot_tools_enabled(self) -> bool:
        return self.shot_video and not self.shot_tools_missing

    @property
    def ffmpeg_required(self) -> bool:
        return (
            self.shot_tools_enabled
            or self.media_generation is not None
            or self.iclip_studio is not None
        )


def _from_env[EnvT: EnvSettings](cls: type[EnvT]) -> EnvT:
    return cls()  # pyright: ignore[reportCallIssue]


def _switched_on(env_name: str) -> bool:
    return bool(os.environ.get(env_name, "").strip())


def _resolve_object_store() -> ObjectStoreEnv | None:
    if not _switched_on(OSS_BUCKET_ENV):
        return None
    return _from_env(ObjectStoreEnv)


def _resolve_media_generation(
    section: MediaGenerationSection | None, *, object_store_on: bool
) -> ResolvedMediaGeneration | None:
    if section is None or not _switched_on(VIDEO_SUBMIT_URL_ENV):
        return None
    if not object_store_on:
        raise RuntimeError(
            f"配了 {VIDEO_SUBMIT_URL_ENV} 但对象存储没开：图片生成结果要转存成自己的公开"
            f"对象，否则库里存的是几天后就失效的签名地址。补上 {OSS_BUCKET_ENV} 那一组"
        )
    env = _from_env(MediaGenerationEnv)
    return ResolvedMediaGeneration(
        video_submit_url=env.video_submit_url,
        video_status_base_url=env.video_status_base_url,
        video_api_key=env.video_api_key,
        video_model=section.video.model,
        video_allowed_models=section.video.allowed_models,
        video_enhance=_resolve_video_enhance(section.video.enhance, env.video_enhance_submit_url),
        image_models=tuple(
            ResolvedImageModel(
                name=name,
                api_base=f"{env.image_api_base.rstrip('/')}/{model.route.strip('/')}",
                concurrency=model.concurrency,
                text_to_image_task=model.text_to_image_task,
                image_edit_task=model.image_edit_task,
            )
            for name, model in section.image.models.items()
        ),
        image_default_model=section.image.default,
        image_env=section.image.env,
        image_text_to_image_task=section.image.text_to_image_task,
        image_edit_task=section.image.image_edit_task,
        poll_interval_seconds=section.poll_interval_seconds,
        job_timeout_seconds=section.job_timeout_seconds,
        compose_concurrency=section.compose_concurrency,
        subtitle=_resolve_qwen_service(section.subtitle),
        music=_resolve_qwen_service(section.music),
    )


def _resolve_video_enhance(
    section: VideoEnhanceSection | None, submit_url: str
) -> ResolvedVideoEnhance | None:
    """提交地址留空就是没开通；配了地址却没写 ``media_generation.video.enhance`` 段报错。"""

    if not submit_url:
        return None
    if section is None:
        raise RuntimeError(
            f"配了 {VIDEO_ENHANCE_SUBMIT_URL_ENV} 却没写 media_generation.video.enhance 段："
            "高清版用哪个模型、提到哪几档都写在那里。补上它，或者清空这个地址"
        )
    return ResolvedVideoEnhance(
        submit_url=submit_url,
        model=section.model,
        resolutions=section.resolutions,
        fps=section.fps,
    )


def _resolve_qwen_service(section: QwenServiceSection | None) -> ResolvedQwenService | None:
    if section is None or not _switched_on(QWEN_API_KEY_ENV):
        return None
    env = _from_env(QwenEnv)
    return ResolvedQwenService(
        url=section.url,
        api_key=env.api_key,
        concurrency=section.concurrency,
        timeout_seconds=section.timeout_seconds,
    )


def _resolve_iclip_studio(section: IclipStudioSection | None) -> ResolvedIclipStudio | None:
    if section is None or not _switched_on(VIDEO_UNDERSTANDING_URL_ENV):
        return None
    env = _from_env(VideoUnderstandingEnv)
    return ResolvedIclipStudio(
        breakdown_url=env.url,
        breakdown_api_key=env.api_key,
        breakdown_model=section.breakdown_model,
        breakdown_concurrency=section.breakdown_concurrency,
    )


def _resolve_product_catalog() -> ResolvedProductCatalog | None:
    if not _switched_on(PRODUCT_CATALOG_DATABASE_URL_ENV):
        return None
    env = _from_env(ProductCatalogEnv)
    return ResolvedProductCatalog(database_url=env.database_url)


def _resolve_whole_film_render(
    *, object_store_on: bool, media_generation_on: bool
) -> ResolvedWholeFilmRender | None:
    if not _switched_on(WHOLE_FILM_RENDER_URL_ENV):
        return None
    missing: list[str] = []
    if not object_store_on:
        missing.append(f"对象存储（{OSS_BUCKET_ENV} 那一组）")
    if not media_generation_on:
        missing.append(f"媒体生成（media_generation 段与 {VIDEO_SUBMIT_URL_ENV} 那一组）")
    if missing:
        raise RuntimeError(
            f"配了 {WHOLE_FILM_RENDER_URL_ENV} 但没开{'与'.join(missing)}：每次导出是一条生成记录，"
            f"由生成队列交给渲染服务，成片上传进桶。补上它们"
        )
    return ResolvedWholeFilmRender(url=_from_env(WholeFilmRenderEnv).url)


def _resolve_runtime_service() -> ResolvedRuntimeService:
    """两个变量缺一个都启动失败：开会话、首页名册、起标题、对话活动与配置页的管理接口都经运行时服务。"""

    env = _from_env(RuntimeServiceEnv)
    return ResolvedRuntimeService(url=env.url, app_key=env.app_key)


def resolve_settings(config: RuntimeConfig) -> ResolvedSettings:
    core = _from_env(CoreEnv)

    sso: ResolvedSso | None = None
    if _switched_on(SSO_BASE_URL_ENV):
        env = _from_env(SsoEnv)
        sso = ResolvedSso(
            base_url=env.base_url,
            app_name=config.sso.app_name,
            redirect_url=env.redirect_url,
            pms_base_url=env.pms_base_url or None,
            root_email=env.root_email or None,
            oauth_name=env.oauth_name or DEFAULT_SSO_OAUTH_NAME,
        )

    object_store = _resolve_object_store()
    media_generation = _resolve_media_generation(
        config.media_generation, object_store_on=object_store is not None
    )
    return ResolvedSettings(
        app_name=config.app.name,
        database_url=core.database_url,
        db_schema=config.db.db_schema,
        security=ResolvedSecurity(
            secret=core.auth_secret,
            lifetime_seconds=config.security.session_lifetime_seconds,
            cookie_secure=config.security.cookie_secure,
            cors_allow_origins=config.security.cors_allow_origins,
        ),
        sso=sso,
        object_store=object_store,
        media_generation=media_generation,
        shot_video=config.shot_video is not None,
        iclip_studio=_resolve_iclip_studio(config.iclip_studio),
        product_catalog=_resolve_product_catalog(),
        whole_film_render=_resolve_whole_film_render(
            object_store_on=object_store is not None,
            media_generation_on=media_generation is not None,
        ),
        # 缺了启动失败：开跑检查在这组内部接口上，没有它每次运行都过不了检查。
        runtime_internal_token=_from_env(RuntimeInternalEnv).token,
        runtime_service=_resolve_runtime_service(),
        log_level=config.ops.log_level,
        log_format=config.ops.log_format,
    )
