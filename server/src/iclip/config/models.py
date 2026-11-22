from __future__ import annotations

import os
import re
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
from iclip.common.urls import is_http_origin

_MIN_SECRET_LENGTH = 32

RequiredEnv = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]

NonEmptyText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]

_MODEL_GROUP_NAME: Final = re.compile(r"^[a-z][a-z0-9_]*$")

_DEFAULT_MODEL_GROUP: Final = "default"

PRODUCT_CATALOG_DATABASE_URL_ENV: Final = "PRODUCT_CATALOG_DATABASE_URL"

_MOVED_TO_CONFIG: Final[Mapping[str, str]] = {
    "SSO_BASE_URL": "sso.base_url",
    "SSO_REDIRECT_URL": "sso.redirect_url",
    "PMS_BASE_URL": "sso.pms_base_url",
    "ROOT_EMAIL": "sso.root_email",
    "SSO_OAUTH_NAME": "sso.oauth_name",
    "OSS_BUCKET": "object_store.bucket",
    "OSS_ENDPOINT": "object_store.endpoint",
    "OSS_PUBLIC_URL_BASE": "object_store.public_url_base",
    "OSS_INTERNAL_ENDPOINT": "object_store.internal_endpoint",
    "VIDEO_SUBMIT_URL": "media_generation.video.submit_url",
    "VIDEO_STATUS_BASE_URL": "media_generation.video.status_base_url",
    "VIDEO_ENHANCE_SUBMIT_URL": "media_generation.video.enhance.submit_url",
    "IMAGE_API_BASE": "media_generation.image.api_base",
    "FINAL_CUT_RENDER_URL": "final_cut.render_url",
    "FINAL_CUT_PREVIEW_ORIGIN": "final_cut.preview_origin",
    "RUNTIME_URL": "runtime.url",
}

_MOVED_TO_RUNTIME: Final[Mapping[str, str]] = {
    "agent_runs": "agent_runs",
    "conversations": "compaction（原 conversations.compaction）",
}

_RETIRED_SECTIONS: Final[Mapping[str, str]] = {
    "video": "视频理解在运行时总是登记，模型写在代码里，连接用配置页的火山方舟",
}


class ConfigSection(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class EnvSettings(BaseSettings):
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


class ObjectStoreKeysEnv(EnvSettings):
    access_key_id: RequiredEnv = Field(validation_alias="OSS_ACCESS_KEY_ID")
    access_key_secret: RequiredEnv = Field(validation_alias="OSS_ACCESS_KEY_SECRET")


class ProductCatalogEnv(EnvSettings):
    database_url: RequiredEnv = Field(validation_alias=PRODUCT_CATALOG_DATABASE_URL_ENV)


class RuntimeInternalEnv(EnvSettings):
    token: RequiredEnv = Field(validation_alias="RUNTIME_INTERNAL_TOKEN")

    @field_validator("token")
    @classmethod
    def _long_enough(cls, value: str) -> str:
        if len(value) < _MIN_SECRET_LENGTH:
            raise ValueError(f"长度必须 ≥ {_MIN_SECRET_LENGTH} 字符")
        return value


class RuntimeAppKeyEnv(EnvSettings):
    app_key: RequiredEnv = Field(validation_alias="RUNTIME_APP_KEY")

    @field_validator("app_key")
    @classmethod
    def _long_enough(cls, value: str) -> str:
        if len(value) < _MIN_SECRET_LENGTH:
            raise ValueError(f"长度必须 ≥ {_MIN_SECRET_LENGTH} 字符")
        return value


def _http_address(value: str, where: str) -> str:
    parts = urlsplit(value)
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        raise ValueError(f"{where} 必须是 http:// 或 https:// 地址")
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
    base_url: NonEmptyText
    redirect_url: NonEmptyText
    pms_base_url: NonEmptyText | None = None
    root_email: NonEmptyText | None = None
    oauth_name: NonEmptyText = "sso"


class ObjectStoreSection(ConfigSection):
    bucket: NonEmptyText
    endpoint: NonEmptyText
    public_url_base: NonEmptyText
    internal_endpoint: NonEmptyText | None = None


class VideoEnhanceSection(ConfigSection):
    submit_url: NonEmptyText
    model: str = Field(min_length=1)
    resolutions: tuple[VideoEnhanceResolution, ...] = Field(min_length=1)
    fps: int | None = Field(default=None, ge=15, le=60)

    @field_validator("resolutions")
    @classmethod
    def _distinct(
        cls, value: tuple[VideoEnhanceResolution, ...]
    ) -> tuple[VideoEnhanceResolution, ...]:
        if len(set(value)) != len(value):
            raise ValueError("enhance.resolutions 不能重复")
        return value


class VideoGenerationSection(ConfigSection):
    submit_url: NonEmptyText
    status_base_url: NonEmptyText
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
    api_base: NonEmptyText
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


class SpeechSection(QwenServiceSection):
    concurrency: int = Field(default=2, gt=0)
    timeout_seconds: float = Field(default=120.0, gt=0)


class MediaGenerationSection(ConfigSection):
    video: VideoGenerationSection
    image: ImageGenerationSection
    poll_interval_seconds: int = Field(default=5, ge=1)
    job_timeout_seconds: int = Field(default=3600, ge=1)
    compose_concurrency: int | None = Field(default=None, ge=1)
    subtitle: SubtitleSection | None = None
    music: MusicSection | None = None
    speech: SpeechSection | None = None


class ModelGroupSection(ConfigSection):
    """一个配置组的媒体 key 与网关 model_id；谁在哪个组由 root 在网页上选，存在数据库里。

    key 的值放在环境变量里，这里只写变量名；``video_models`` 是「产品模型名 → 该组网关 model_id」。
    组名 ``default`` 是保留名：没选组的人用它，开了媒体生成就必须有，不能选给人。
    """

    video_api_key_env: NonEmptyText
    subtitle_api_key_env: NonEmptyText | None = None
    music_api_key_env: NonEmptyText | None = None
    speech_api_key_env: NonEmptyText | None = None
    video_models: dict[NonEmptyText, NonEmptyText]


class IclipStudioSection(ConfigSection):
    breakdown_concurrency: int | None = Field(default=None, ge=1)


class ShotVideoSection(ConfigSection):
    pass


class ProductCatalogSection(ConfigSection):
    pass


class FinalCutSection(ConfigSection):
    render_url: NonEmptyText | None = None
    preview_origin: NonEmptyText | None = None

    @field_validator("render_url")
    @classmethod
    def _render_url_is_http(cls, value: str | None) -> str | None:
        return None if value is None else _http_address(value, "final_cut.render_url")

    @field_validator("preview_origin")
    @classmethod
    def _preview_origin_is_bare(cls, value: str | None) -> str | None:
        if value is None:
            return None
        origin = value.removesuffix("/")
        if not is_http_origin(origin):
            raise ValueError("final_cut.preview_origin 必须是 http(s)://主机[:端口]，不带路径")
        return origin


class RuntimeServiceSection(ConfigSection):
    url: NonEmptyText

    @field_validator("url")
    @classmethod
    def _url_is_http(cls, value: str) -> str:
        return _http_address(value, "runtime.url")


class OpsSection(ConfigSection):
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    log_format: Literal["console", "json"] = "console"


class RuntimeConfig(BaseSettings):
    model_config = SettingsConfigDict(frozen=True, extra="forbid")

    app: AppSection
    db: DbSection
    security: SecuritySection
    sso: SsoSection | None = None
    object_store: ObjectStoreSection | None = None
    media_generation: MediaGenerationSection | None = None
    shot_video: ShotVideoSection | None = None
    iclip_studio: IclipStudioSection | None = None
    product_catalog: ProductCatalogSection | None = None
    final_cut: FinalCutSection = FinalCutSection()
    model_groups: dict[str, ModelGroupSection] | None = None
    runtime: RuntimeServiceSection
    ops: OpsSection = OpsSection()

    @field_validator("model_groups")
    @classmethod
    def _model_groups_well_formed(
        cls, value: dict[str, ModelGroupSection] | None
    ) -> dict[str, ModelGroupSection] | None:
        if value is None:
            return value
        for name in value:
            if _MODEL_GROUP_NAME.fullmatch(name) is None:
                raise ValueError(
                    f"model_groups 的组名 {name!r} 不合规：以小写字母开头，只用小写字母、数字和下划线"
                )
        return value

    @model_validator(mode="before")
    @classmethod
    def _no_sections_moved_to_the_runtime(cls, data: Any) -> Any:
        if not isinstance(data, Mapping):
            return data
        sections: Mapping[str, Any] = data
        for name, moved_to in _MOVED_TO_RUNTIME.items():
            if name in sections:
                raise ValueError(
                    f"{name} 段已搬到运行时服务的配置（configs/runtime.yaml 的 {moved_to}），"
                    "从后端的配置文件里删掉它"
                )
        for name, why in _RETIRED_SECTIONS.items():
            if name in sections:
                raise ValueError(f"{name} 段已不用（{why}），从后端的配置文件里删掉它")
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
class ResolvedObjectStore:
    bucket: str
    endpoint: str
    access_key_id: str
    access_key_secret: str
    public_url_base: str
    internal_endpoint: str | None


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
    concurrency: int
    timeout_seconds: float


@dataclass(frozen=True, slots=True)
class ResolvedVideoEnhance:
    submit_url: str
    model: str
    resolutions: tuple[VideoEnhanceResolution, ...]
    fps: int | None


@dataclass(frozen=True, slots=True)
class ResolvedMediaModelGroup:
    """配置组在媒体生成里用的 key 与网关 model_id；字幕、配乐、配音没开通时对应的 key 为 ``None``。"""

    name: str
    video_api_key: str
    video_models: Mapping[str, str]
    subtitle_api_key: str | None
    music_api_key: str | None
    speech_api_key: str | None


@dataclass(frozen=True, slots=True)
class ResolvedMediaGeneration:
    video_submit_url: str
    video_status_base_url: str
    video_model: str
    video_allowed_models: tuple[str, ...]
    video_enhance: ResolvedVideoEnhance | None
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
    speech: ResolvedQwenService | None
    default_model_group: ResolvedMediaModelGroup
    """``model_groups.default``：没选组的人用的 key 与 model_id。"""
    model_groups: tuple[ResolvedMediaModelGroup, ...]
    """其余配置组，按配置里的先后。"""


@dataclass(frozen=True, slots=True)
class ResolvedIclipStudio:
    breakdown_concurrency: int | None


@dataclass(frozen=True, slots=True)
class ResolvedProductCatalog:
    database_url: str


@dataclass(frozen=True, slots=True)
class ResolvedFinalCutRender:
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
    object_store: ResolvedObjectStore | None
    media_generation: ResolvedMediaGeneration | None
    model_groups: tuple[str, ...]
    """部署配置里能选给人的配置组名（不含 ``default``），按配置里的先后。"""
    shot_video: bool
    iclip_studio: ResolvedIclipStudio | None
    product_catalog: ResolvedProductCatalog | None
    final_cut_render: ResolvedFinalCutRender | None
    final_cut_preview_origin: str | None
    runtime_internal_token: str
    runtime_service: ResolvedRuntimeService
    log_level: str
    log_format: Literal["console", "json"]

    @property
    def shot_tools_missing(self) -> tuple[str, ...]:
        if not self.shot_video:
            return ()
        return tuple(
            name
            for name, present in (
                ("media_generation", self.media_generation is not None),
                ("object_store", self.object_store is not None),
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
    return cls()


def _env_has_value(env_name: str) -> bool:
    return bool(os.environ.get(env_name, "").strip())


def _reject_moved_env() -> None:
    left = [
        f"环境变量 {name} 已搬到 config.yaml 的 {path}，从 .env 里删掉它"
        for name, path in _MOVED_TO_CONFIG.items()
        if _env_has_value(name)
    ]
    if left:
        raise RuntimeError("\n".join(left))


def _resolve_sso(section: SsoSection | None) -> ResolvedSso | None:
    if section is None:
        return None
    return ResolvedSso(
        base_url=section.base_url,
        app_name=section.app_name,
        redirect_url=section.redirect_url,
        pms_base_url=section.pms_base_url,
        root_email=section.root_email,
        oauth_name=section.oauth_name,
    )


def _resolve_object_store(section: ObjectStoreSection | None) -> ResolvedObjectStore | None:
    if section is None:
        return None
    keys = _from_env(ObjectStoreKeysEnv)
    return ResolvedObjectStore(
        bucket=section.bucket,
        endpoint=section.endpoint,
        access_key_id=keys.access_key_id,
        access_key_secret=keys.access_key_secret,
        public_url_base=section.public_url_base,
        internal_endpoint=section.internal_endpoint,
    )


def _resolve_media_generation(
    section: MediaGenerationSection | None,
    *,
    object_store_on: bool,
    model_groups: Mapping[str, ModelGroupSection],
) -> ResolvedMediaGeneration | None:
    if section is None:
        return None
    if not object_store_on:
        raise RuntimeError(
            "写了 media_generation 段但没写 object_store 段：图片生成结果要转存成自己的公开"
            "对象，否则库里存的是几天后就失效的签名地址。补上 object_store 段"
        )
    if _DEFAULT_MODEL_GROUP not in model_groups:
        raise RuntimeError(
            f"model_groups 里没有 {_DEFAULT_MODEL_GROUP}：开了媒体生成，没选组的人要用这一组的 "
            "key 与 model_id，补上它"
        )
    enhance = _resolve_video_enhance(section.video.enhance)
    subtitle = _resolve_qwen_service(section.subtitle)
    music = _resolve_qwen_service(section.music)
    speech = _resolve_qwen_service(section.speech)
    groups = {
        name: _resolve_media_model_group(
            name,
            group,
            video_models=frozenset(section.video.allowed_models),
            enhance_model=None if enhance is None else enhance.model,
            subtitle_on=subtitle is not None,
            music_on=music is not None,
            speech_on=speech is not None,
        )
        for name, group in model_groups.items()
    }
    default = groups.pop(_DEFAULT_MODEL_GROUP)
    return ResolvedMediaGeneration(
        video_submit_url=section.video.submit_url,
        video_status_base_url=section.video.status_base_url,
        video_model=section.video.model,
        video_allowed_models=section.video.allowed_models,
        video_enhance=enhance,
        image_models=tuple(
            ResolvedImageModel(
                name=name,
                api_base=f"{section.image.api_base.rstrip('/')}/{model.route.strip('/')}",
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
        subtitle=subtitle,
        music=music,
        speech=speech,
        default_model_group=default,
        model_groups=tuple(groups.values()),
    )


def _resolve_media_model_group(
    name: str,
    group: ModelGroupSection,
    *,
    video_models: frozenset[str],
    enhance_model: str | None,
    subtitle_on: bool,
    music_on: bool,
    speech_on: bool,
) -> ResolvedMediaModelGroup:
    where = f"model_groups.{name}"
    expected = video_models if enhance_model is None else video_models | {enhance_model}
    which = "allowed_models 里的每个模型" + ("与高清版模型 enhance.model" if enhance_model else "")
    missing = sorted(expected - group.video_models.keys())
    if missing:
        raise RuntimeError(
            f"{where}.video_models 缺 {'、'.join(missing)}：要给{which}写上该组的 model_id"
        )
    extra = sorted(group.video_models.keys() - expected)
    if extra:
        raise RuntimeError(f"{where}.video_models 多了 {'、'.join(extra)}：只写{which}")
    return ResolvedMediaModelGroup(
        name=name,
        video_api_key=_group_key(where, "video_api_key_env", group.video_api_key_env),
        video_models=dict(group.video_models),
        subtitle_api_key=_group_key(where, "subtitle_api_key_env", group.subtitle_api_key_env)
        if subtitle_on
        else None,
        music_api_key=_group_key(where, "music_api_key_env", group.music_api_key_env)
        if music_on
        else None,
        speech_api_key=_group_key(where, "speech_api_key_env", group.speech_api_key_env)
        if speech_on
        else None,
    )


def _group_key(where: str, field: str, env_name: str | None) -> str:
    if env_name is None:
        raise RuntimeError(f"{where}.{field} 没写：这项功能开通了，每个组都要指定自己的 key 变量名")
    value = os.environ.get(env_name, "").strip()
    if not value:
        raise RuntimeError(f"{where}.{field} 指定的环境变量 {env_name} 没有值")
    return value


def _resolve_video_enhance(section: VideoEnhanceSection | None) -> ResolvedVideoEnhance | None:
    if section is None:
        return None
    return ResolvedVideoEnhance(
        submit_url=section.submit_url,
        model=section.model,
        resolutions=section.resolutions,
        fps=section.fps,
    )


def _resolve_qwen_service(section: QwenServiceSection | None) -> ResolvedQwenService | None:
    if section is None:
        return None
    return ResolvedQwenService(
        url=section.url,
        concurrency=section.concurrency,
        timeout_seconds=section.timeout_seconds,
    )


def _resolve_iclip_studio(section: IclipStudioSection | None) -> ResolvedIclipStudio | None:
    if section is None:
        return None
    return ResolvedIclipStudio(breakdown_concurrency=section.breakdown_concurrency)


def _resolve_product_catalog(
    section: ProductCatalogSection | None,
) -> ResolvedProductCatalog | None:
    if section is None:
        if _env_has_value(PRODUCT_CATALOG_DATABASE_URL_ENV):
            raise RuntimeError(
                f"环境变量 {PRODUCT_CATALOG_DATABASE_URL_ENV} 有值但 config.yaml 没写 product_catalog "
                "段：要开产品资料查询就写 product_catalog: {}，不开就从 .env 里删掉这个变量"
            )
        return None
    return ResolvedProductCatalog(database_url=_from_env(ProductCatalogEnv).database_url)


def _resolve_final_cut_render(
    render_url: str | None, *, object_store_on: bool, media_generation_on: bool
) -> ResolvedFinalCutRender | None:
    if render_url is None:
        return None
    missing: list[str] = []
    if not object_store_on:
        missing.append("object_store 段")
    if not media_generation_on:
        missing.append("media_generation 段")
    if missing:
        raise RuntimeError(
            f"写了 final_cut.render_url 但没写{'与'.join(missing)}：每次导出是一条生成记录，"
            "由生成队列交给渲染服务，成片上传进桶。补上它们"
        )
    return ResolvedFinalCutRender(url=render_url)


def resolve_settings(config: RuntimeConfig) -> ResolvedSettings:
    _reject_moved_env()
    core = _from_env(CoreEnv)
    object_store = _resolve_object_store(config.object_store)
    model_groups = config.model_groups or {}
    media_generation = _resolve_media_generation(
        config.media_generation,
        object_store_on=object_store is not None,
        model_groups=model_groups,
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
        sso=_resolve_sso(config.sso),
        object_store=object_store,
        media_generation=media_generation,
        model_groups=tuple(name for name in model_groups if name != _DEFAULT_MODEL_GROUP),
        shot_video=config.shot_video is not None,
        iclip_studio=_resolve_iclip_studio(config.iclip_studio),
        product_catalog=_resolve_product_catalog(config.product_catalog),
        final_cut_render=_resolve_final_cut_render(
            config.final_cut.render_url,
            object_store_on=object_store is not None,
            media_generation_on=media_generation is not None,
        ),
        final_cut_preview_origin=config.final_cut.preview_origin,
        runtime_internal_token=_from_env(RuntimeInternalEnv).token,
        runtime_service=ResolvedRuntimeService(
            url=config.runtime.url, app_key=_from_env(RuntimeAppKeyEnv).app_key
        ),
        log_level=config.ops.log_level,
        log_format=config.ops.log_format,
    )
