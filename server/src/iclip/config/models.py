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

OptionalEnv = Annotated[str, StringConstraints(strip_whitespace=True)]

SSO_BASE_URL_ENV: Final = "SSO_BASE_URL"

DEFAULT_SSO_OAUTH_NAME: Final = "sso"

OSS_BUCKET_ENV: Final = "OSS_BUCKET"

VIDEO_SUBMIT_URL_ENV: Final = "VIDEO_SUBMIT_URL"

VIDEO_ENHANCE_SUBMIT_URL_ENV: Final = "VIDEO_ENHANCE_SUBMIT_URL"

QWEN_SUBTITLE_API_KEY_ENV: Final = "QWEN_SUBTITLE_API_KEY"

QWEN_MUSIC_API_KEY_ENV: Final = "QWEN_MUSIC_API_KEY"

_MODEL_GROUP_NAME: Final = re.compile(r"^[a-z][a-z0-9_]*$")

PRODUCT_CATALOG_DATABASE_URL_ENV: Final = "PRODUCT_CATALOG_DATABASE_URL"

FINAL_CUT_RENDER_URL_ENV: Final = "FINAL_CUT_RENDER_URL"

FINAL_CUT_PREVIEW_ORIGIN_ENV: Final = "FINAL_CUT_PREVIEW_ORIGIN"

RUNTIME_INTERNAL_TOKEN_ENV: Final = "RUNTIME_INTERNAL_TOKEN"

RUNTIME_URL_ENV: Final = "RUNTIME_URL"

RUNTIME_APP_KEY_ENV: Final = "RUNTIME_APP_KEY"

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
    internal_endpoint: OptionalEnv = Field("", validation_alias="OSS_INTERNAL_ENDPOINT")


class MediaGenerationEnv(EnvSettings):
    video_submit_url: RequiredEnv = Field(validation_alias=VIDEO_SUBMIT_URL_ENV)
    video_status_base_url: RequiredEnv = Field(validation_alias="VIDEO_STATUS_BASE_URL")
    video_api_key: RequiredEnv = Field(validation_alias="VIDEO_API_KEY")
    image_api_base: RequiredEnv = Field(validation_alias="IMAGE_API_BASE")
    video_enhance_submit_url: OptionalEnv = Field("", validation_alias=VIDEO_ENHANCE_SUBMIT_URL_ENV)


class ProductCatalogEnv(EnvSettings):
    database_url: RequiredEnv = Field(validation_alias=PRODUCT_CATALOG_DATABASE_URL_ENV)


class FinalCutRenderEnv(EnvSettings):
    url: RequiredEnv = Field(validation_alias=FINAL_CUT_RENDER_URL_ENV)

    @field_validator("url")
    @classmethod
    def _http_url(cls, value: str) -> str:
        parts = urlsplit(value)
        if parts.scheme not in {"http", "https"} or not parts.netloc:
            raise ValueError(f"{FINAL_CUT_RENDER_URL_ENV} 必须是 http:// 或 https:// 地址")
        return value.rstrip("/")


class FinalCutPreviewEnv(EnvSettings):
    origin: RequiredEnv = Field(validation_alias=FINAL_CUT_PREVIEW_ORIGIN_ENV)

    @field_validator("origin")
    @classmethod
    def _http_origin(cls, value: str) -> str:
        origin = value.removesuffix("/")
        if not is_http_origin(origin):
            raise ValueError(
                f"{FINAL_CUT_PREVIEW_ORIGIN_ENV} 必须是 http(s)://主机[:端口]，不带路径"
            )
        return origin


class RuntimeInternalEnv(EnvSettings):
    token: RequiredEnv = Field(validation_alias=RUNTIME_INTERNAL_TOKEN_ENV)

    @field_validator("token")
    @classmethod
    def _long_enough(cls, value: str) -> str:
        if len(value) < _MIN_SECRET_LENGTH:
            raise ValueError(f"长度必须 ≥ {_MIN_SECRET_LENGTH} 字符")
        return value


class RuntimeServiceEnv(EnvSettings):
    url: RequiredEnv = Field(validation_alias=RUNTIME_URL_ENV)
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


NonEmptyText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class ModelGroupSection(ConfigSection):
    """一个配置组：哪些 PMS 部门（用户直属部门的数字 id）用这一组的 key 与网关 model_id。

    key 的值放在环境变量里，这里只写变量名；``video_models`` 是「产品模型名 → 该组网关 model_id」。
    """

    departments: tuple[int, ...]
    video_api_key_env: NonEmptyText
    subtitle_api_key_env: NonEmptyText | None = None
    music_api_key_env: NonEmptyText | None = None
    video_models: dict[NonEmptyText, NonEmptyText]


class IclipStudioSection(ConfigSection):
    breakdown_concurrency: int | None = Field(default=None, ge=1)


class ShotVideoSection(ConfigSection):
    pass


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
    model_groups: dict[str, ModelGroupSection] | None = None
    ops: OpsSection = OpsSection()

    @field_validator("model_groups")
    @classmethod
    def _model_groups_well_formed(
        cls, value: dict[str, ModelGroupSection] | None
    ) -> dict[str, ModelGroupSection] | None:
        if value is None:
            return value
        owners: dict[int, str] = {}
        for name, group in value.items():
            if _MODEL_GROUP_NAME.fullmatch(name) is None:
                raise ValueError(
                    f"model_groups 的组名 {name!r} 不合规：以小写字母开头，只用小写字母、数字和下划线"
                )
            for department in group.departments:
                other = owners.setdefault(department, name)
                if other != name:
                    raise ValueError(
                        f"部门 {department} 同时写在 model_groups.{other} 与 model_groups.{name} 里，"
                        "一个部门只能属于一个组"
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
class ResolvedModelGroup:
    """配置组的归属：组名与它的部门 id，按配置里的先后排列。"""

    name: str
    departments: tuple[int, ...]


@dataclass(frozen=True, slots=True)
class ResolvedMediaModelGroup:
    """配置组在媒体生成里用的 key 与网关 model_id；字幕、配乐没开通时对应的 key 为 ``None``。"""

    name: str
    video_api_key: str
    video_models: Mapping[str, str]
    subtitle_api_key: str | None
    music_api_key: str | None


@dataclass(frozen=True, slots=True)
class ResolvedMediaGeneration:
    video_submit_url: str
    video_status_base_url: str
    video_api_key: str
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
    model_groups: tuple[ResolvedMediaModelGroup, ...]


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
    object_store: ObjectStoreEnv | None
    media_generation: ResolvedMediaGeneration | None
    model_groups: tuple[ResolvedModelGroup, ...]
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
    return cls()


def _switched_on(env_name: str) -> bool:
    return bool(os.environ.get(env_name, "").strip())


def _resolve_object_store() -> ObjectStoreEnv | None:
    if not _switched_on(OSS_BUCKET_ENV):
        return None
    return _from_env(ObjectStoreEnv)


def _resolve_media_generation(
    section: MediaGenerationSection | None,
    *,
    object_store_on: bool,
    model_groups: Mapping[str, ModelGroupSection],
) -> ResolvedMediaGeneration | None:
    if section is None or not _switched_on(VIDEO_SUBMIT_URL_ENV):
        return None
    if not object_store_on:
        raise RuntimeError(
            f"配了 {VIDEO_SUBMIT_URL_ENV} 但对象存储没开：图片生成结果要转存成自己的公开"
            f"对象，否则库里存的是几天后就失效的签名地址。补上 {OSS_BUCKET_ENV} 那一组"
        )
    env = _from_env(MediaGenerationEnv)
    enhance = _resolve_video_enhance(section.video.enhance, env.video_enhance_submit_url)
    subtitle = _resolve_qwen_service(section.subtitle, QWEN_SUBTITLE_API_KEY_ENV)
    music = _resolve_qwen_service(section.music, QWEN_MUSIC_API_KEY_ENV)
    return ResolvedMediaGeneration(
        video_submit_url=env.video_submit_url,
        video_status_base_url=env.video_status_base_url,
        video_api_key=env.video_api_key,
        video_model=section.video.model,
        video_allowed_models=section.video.allowed_models,
        video_enhance=enhance,
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
        subtitle=subtitle,
        music=music,
        model_groups=tuple(
            _resolve_media_model_group(
                name,
                group,
                video_models=frozenset(section.video.allowed_models),
                enhance_model=None if enhance is None else enhance.model,
                subtitle_on=subtitle is not None,
                music_on=music is not None,
            )
            for name, group in model_groups.items()
        ),
    )


def _resolve_media_model_group(
    name: str,
    group: ModelGroupSection,
    *,
    video_models: frozenset[str],
    enhance_model: str | None,
    subtitle_on: bool,
    music_on: bool,
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
    )


def _group_key(where: str, field: str, env_name: str | None) -> str:
    if env_name is None:
        raise RuntimeError(f"{where}.{field} 没写：这项功能开通了，每个组都要指定自己的 key 变量名")
    value = os.environ.get(env_name, "").strip()
    if not value:
        raise RuntimeError(f"{where}.{field} 指定的环境变量 {env_name} 没有值")
    return value


def _resolve_video_enhance(
    section: VideoEnhanceSection | None, submit_url: str
) -> ResolvedVideoEnhance | None:
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


def _resolve_qwen_service(
    section: QwenServiceSection | None, key_env: str
) -> ResolvedQwenService | None:
    if section is None or not _switched_on(key_env):
        return None
    return ResolvedQwenService(
        url=section.url,
        api_key=os.environ[key_env].strip(),
        concurrency=section.concurrency,
        timeout_seconds=section.timeout_seconds,
    )


def _resolve_iclip_studio(section: IclipStudioSection | None) -> ResolvedIclipStudio | None:
    if section is None:
        return None
    return ResolvedIclipStudio(breakdown_concurrency=section.breakdown_concurrency)


def _resolve_product_catalog() -> ResolvedProductCatalog | None:
    if not _switched_on(PRODUCT_CATALOG_DATABASE_URL_ENV):
        return None
    env = _from_env(ProductCatalogEnv)
    return ResolvedProductCatalog(database_url=env.database_url)


def _resolve_final_cut_render(
    *, object_store_on: bool, media_generation_on: bool
) -> ResolvedFinalCutRender | None:
    if not _switched_on(FINAL_CUT_RENDER_URL_ENV):
        return None
    missing: list[str] = []
    if not object_store_on:
        missing.append(f"对象存储（{OSS_BUCKET_ENV} 那一组）")
    if not media_generation_on:
        missing.append(f"媒体生成（media_generation 段与 {VIDEO_SUBMIT_URL_ENV} 那一组）")
    if missing:
        raise RuntimeError(
            f"配了 {FINAL_CUT_RENDER_URL_ENV} 但没开{'与'.join(missing)}：每次导出是一条生成记录，"
            f"由生成队列交给渲染服务，成片上传进桶。补上它们"
        )
    return ResolvedFinalCutRender(url=_from_env(FinalCutRenderEnv).url)


def _resolve_final_cut_preview_origin() -> str | None:
    if not _switched_on(FINAL_CUT_PREVIEW_ORIGIN_ENV):
        return None
    return _from_env(FinalCutPreviewEnv).origin


def _resolve_runtime_service() -> ResolvedRuntimeService:
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
        sso=sso,
        object_store=object_store,
        media_generation=media_generation,
        model_groups=tuple(
            ResolvedModelGroup(name=name, departments=group.departments)
            for name, group in model_groups.items()
        ),
        shot_video=config.shot_video is not None,
        iclip_studio=_resolve_iclip_studio(config.iclip_studio),
        product_catalog=_resolve_product_catalog(),
        final_cut_render=_resolve_final_cut_render(
            object_store_on=object_store is not None,
            media_generation_on=media_generation is not None,
        ),
        final_cut_preview_origin=_resolve_final_cut_preview_origin(),
        runtime_internal_token=_from_env(RuntimeInternalEnv).token,
        runtime_service=_resolve_runtime_service(),
        log_level=config.ops.log_level,
        log_format=config.ops.log_format,
    )
