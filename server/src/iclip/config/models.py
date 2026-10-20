from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Final, Literal
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


class ConfigSection(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class EnvSettings(BaseSettings):
    model_config = SettingsConfigDict(frozen=True, extra="ignore")


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
    """整片渲染服务的内网根地址（compose 里的服务名），只给服务端用。"""

    @field_validator("url")
    @classmethod
    def _http_url(cls, value: str) -> str:
        parts = urlsplit(value)
        if parts.scheme not in {"http", "https"} or not parts.netloc:
            raise ValueError(f"{WHOLE_FILM_RENDER_URL_ENV} 必须是 http:// 或 https:// 地址")
        return value.rstrip("/")


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


class ModelSection(ConfigSection):
    provider: str
    api: Literal["chat", "responses"] = "chat"
    api_key_env: str
    base_url: str | None = None
    model: str | None = None
    thinking: ThinkingEffort | None = None
    context_window: int | None = Field(default=None, gt=0)


ThinkingEffort = Literal["none", "minimal", "low", "medium", "high", "xhigh", "max"]

# 方舟收到别的取值会静默改用默认档。
ArkReasoningEffort = Literal["minimal", "low", "medium", "high"]


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


class VideoSection(ConfigSection):
    understanding_model: str
    understanding_thinking: ArkReasoningEffort | None = None
    understanding_fps: float | None = Field(default=None, ge=0.2, le=5)


class IclipStudioSection(ConfigSection):
    breakdown_model: str
    breakdown_concurrency: int | None = Field(default=None, ge=1)


class ShotVideoSection(ConfigSection):
    poll_interval_seconds: float = Field(default=5.0, gt=0)
    dev_attempts: int = Field(default=2, ge=1)
    pro_attempts: int = Field(default=1, ge=0)
    backoff_seconds: float = Field(default=5.0, gt=0)
    backoff_factor: float = Field(default=3.0, ge=1)
    job_timeout_seconds: float = Field(default=1800.0, gt=0)


class CompactionSection(ConfigSection):
    max_fraction: float = Field(default=0.85, gt=0, lt=1)
    keep_messages: int = Field(default=20, ge=1)


class ConversationsSection(ConfigSection):
    title_model: str | None = None
    compaction: CompactionSection = CompactionSection()


class AgentRunsSection(ConfigSection):
    heartbeat_seconds: int = Field(default=10, gt=0)
    lease_seconds: int = Field(default=30, gt=0)
    sweep_seconds: int = Field(default=15, gt=0)
    max_attempts: int = Field(default=2, ge=1)
    max_snapshots_per_run: int = Field(default=3, ge=1)

    @model_validator(mode="after")
    def _lease_outlasts_a_heartbeat(self) -> AgentRunsSection:
        if self.lease_seconds <= self.heartbeat_seconds:
            raise ValueError("lease_seconds 必须大于 heartbeat_seconds")
        return self


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
    video: VideoSection | None = None
    shot_video: ShotVideoSection | None = None
    iclip_studio: IclipStudioSection | None = None
    models: dict[str, ModelSection] = Field(default_factory=dict[str, ModelSection])
    conversations: ConversationsSection = ConversationsSection()
    agent_runs: AgentRunsSection = AgentRunsSection()
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
class ResolvedVideo:
    understanding_url: str
    understanding_api_key: str
    understanding_model: str
    understanding_thinking: ArkReasoningEffort | None
    understanding_fps: float | None


@dataclass(frozen=True, slots=True)
class ResolvedIclipStudio:
    breakdown_url: str
    breakdown_api_key: str
    breakdown_model: str
    breakdown_concurrency: int | None


@dataclass(frozen=True, slots=True)
class ResolvedShotVideo:
    poll_interval_seconds: float
    dev_attempts: int
    pro_attempts: int
    backoff_seconds: float
    backoff_factor: float
    job_timeout_seconds: float


@dataclass(frozen=True, slots=True)
class ResolvedProductCatalog:
    database_url: str


@dataclass(frozen=True, slots=True)
class ResolvedWholeFilmRender:
    url: str


@dataclass(frozen=True, slots=True)
class ResolvedAgentRuns:
    heartbeat_seconds: int
    lease_seconds: int
    sweep_seconds: int
    max_attempts: int
    max_snapshots_per_run: int


@dataclass(frozen=True, slots=True)
class ResolvedCompaction:
    max_fraction: float
    keep_messages: int


@dataclass(frozen=True, slots=True)
class ResolvedModel:
    name: str
    provider: str
    model: str
    api: Literal["chat", "responses"]
    api_key: str
    base_url: str | None
    thinking: ThinkingEffort | None
    context_window: int | None


@dataclass(frozen=True, slots=True)
class ResolvedSettings:
    app_name: str
    database_url: str
    db_schema: str
    security: ResolvedSecurity
    sso: ResolvedSso | None
    object_store: ObjectStoreEnv | None
    media_generation: ResolvedMediaGeneration | None
    video: ResolvedVideo | None
    shot_video: ResolvedShotVideo | None
    iclip_studio: ResolvedIclipStudio | None
    product_catalog: ResolvedProductCatalog | None
    whole_film_render: ResolvedWholeFilmRender | None
    """整片导出用的渲染服务；为 None 时导出端点答「没有开通」。"""
    models: tuple[ResolvedModel, ...]
    title_model: str | None
    compaction: ResolvedCompaction
    agent_runs: ResolvedAgentRuns
    log_level: str
    log_format: Literal["console", "json"]

    @property
    def shot_tools_missing(self) -> tuple[str, ...]:
        if self.shot_video is None:
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
        return self.shot_video is not None and not self.shot_tools_missing

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


def _resolve_video(section: VideoSection | None) -> ResolvedVideo | None:
    if section is None or not _switched_on(VIDEO_UNDERSTANDING_URL_ENV):
        return None
    env = _from_env(VideoUnderstandingEnv)
    return ResolvedVideo(
        understanding_url=env.url,
        understanding_api_key=env.api_key,
        understanding_model=section.understanding_model,
        understanding_thinking=section.understanding_thinking,
        understanding_fps=section.understanding_fps,
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


def _resolve_shot_video(section: ShotVideoSection | None) -> ResolvedShotVideo | None:
    if section is None:
        return None
    return ResolvedShotVideo(
        poll_interval_seconds=section.poll_interval_seconds,
        dev_attempts=section.dev_attempts,
        pro_attempts=section.pro_attempts,
        backoff_seconds=section.backoff_seconds,
        backoff_factor=section.backoff_factor,
        job_timeout_seconds=section.job_timeout_seconds,
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
            f"由生成队列交给渲染服务，整片上传进桶。补上它们"
        )
    return ResolvedWholeFilmRender(url=_from_env(WholeFilmRenderEnv).url)


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
        video=_resolve_video(config.video),
        shot_video=_resolve_shot_video(config.shot_video),
        iclip_studio=_resolve_iclip_studio(config.iclip_studio),
        product_catalog=_resolve_product_catalog(),
        whole_film_render=_resolve_whole_film_render(
            object_store_on=object_store is not None,
            media_generation_on=media_generation is not None,
        ),
        models=tuple(
            ResolvedModel(
                name=name,
                provider=model.provider,
                model=model.model or name,
                api=model.api,
                api_key=_require_model_key(name, model.api_key_env),
                base_url=model.base_url,
                thinking=model.thinking,
                context_window=model.context_window,
            )
            for name, model in config.models.items()
        ),
        title_model=config.conversations.title_model,
        compaction=ResolvedCompaction(
            max_fraction=config.conversations.compaction.max_fraction,
            keep_messages=config.conversations.compaction.keep_messages,
        ),
        agent_runs=ResolvedAgentRuns(
            heartbeat_seconds=config.agent_runs.heartbeat_seconds,
            lease_seconds=config.agent_runs.lease_seconds,
            sweep_seconds=config.agent_runs.sweep_seconds,
            max_attempts=config.agent_runs.max_attempts,
            max_snapshots_per_run=config.agent_runs.max_snapshots_per_run,
        ),
        log_level=config.ops.log_level,
        log_format=config.ops.log_format,
    )


def _require_model_key(name: str, env_name: str) -> str:
    value = os.environ.get(env_name, "").strip()
    if not value:
        raise RuntimeError(f"缺少运行必需的环境变量 {env_name}（模型 {name} 的 API Key）")
    return value
