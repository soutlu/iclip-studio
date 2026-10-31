"""验证 YAML 形状和环境变量的配置契约。

每项测试先清理服务使用的环境变量，避免读取开发机配置。
"""

from __future__ import annotations

from pathlib import Path

import pytest
from cryptography.fernet import Fernet
from pydantic import ValidationError

from iclip.config import (
    CredentialKeysEnv,
    load_runtime_config,
    resolve_settings,
)

DB_URL = "postgresql+asyncpg://x"

MANIFEST = (
    "DATABASE_URL",
    "AUTH_SECRET",
    "CREDENTIAL_ENCRYPTION_KEYS",
    "SSO_BASE_URL",
    "SSO_REDIRECT_URL",
    "PMS_BASE_URL",
    "ROOT_EMAIL",
    "VIDEO_SUBMIT_URL",
    "VIDEO_ENHANCE_SUBMIT_URL",
    "VIDEO_STATUS_BASE_URL",
    "VIDEO_API_KEY",
    "IMAGE_API_BASE",
    "OSS_BUCKET",
    "OSS_ENDPOINT",
    "OSS_ACCESS_KEY_ID",
    "OSS_ACCESS_KEY_SECRET",
    "OSS_PUBLIC_URL_BASE",
    "OSS_INTERNAL_ENDPOINT",
    "VIDEO_UNDERSTANDING_URL",
    "VIDEO_UNDERSTANDING_API_KEY",
    "PRODUCT_CATALOG_DATABASE_URL",
    "QWEN_API_KEY",
    "T_QWEN_KEY",
    "WHOLE_FILM_RENDER_URL",
    "RUNTIME_INTERNAL_TOKEN",
    "RUNTIME_URL",
    "RUNTIME_APP_KEY",
)


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in MANIFEST:
        monkeypatch.delenv(name, raising=False)


VALID = """
app: {name: t}
db: {schema: iclip}
security: {}
sso: {app_name: iclip}
ops: {log_level: INFO}
"""


def write(tmp_path: Path, content: str) -> Path:
    path = tmp_path / "config.yaml"
    path.write_text(content, encoding="utf-8")
    return path


def _core(monkeypatch: pytest.MonkeyPatch) -> None:

    monkeypatch.setenv("DATABASE_URL", DB_URL)
    monkeypatch.setenv("AUTH_SECRET", "s" * 32)
    monkeypatch.setenv("RUNTIME_URL", RUNTIME_URL)
    monkeypatch.setenv("RUNTIME_APP_KEY", RUNTIME_KEY)
    monkeypatch.setenv("RUNTIME_INTERNAL_TOKEN", INTERNAL_TOKEN)


RUNTIME_URL = "http://runtime:7790"
RUNTIME_KEY = "runtime-app-key-for-config-tests-0123"
INTERNAL_TOKEN = "runtime-internal-token-for-config-0123"


@pytest.mark.parametrize(
    ("content", "key"),
    [
        (VALID + "\nextra_section: {}\n", "extra_section"),
        (VALID.replace("db: {schema: iclip}", "db: {schema: iclip, retries: 3}"), "retries"),
    ],
    ids=["top-level", "in-section"],
)
def test_unknown_key_rejected(tmp_path: Path, content: str, key: str) -> None:
    with pytest.raises(ValidationError, match=key):
        load_runtime_config(write(tmp_path, content))


@pytest.mark.parametrize(
    ("section", "moved_to"),
    [
        ("agent_runs: {max_attempts: 2}", "configs/runtime.yaml 的 agent_runs"),
        ("conversations: {compaction: {keep_messages: 20}}", "configs/runtime.yaml 的 compaction"),
        ("video: {understanding_model: seed}", "configs/runtime.yaml 的 plugins.config.video"),
        ("shot_video: {dev_attempts: 2}", "configs/runtime.yaml 的 plugins.config.shot_video"),
    ],
    ids=["agent_runs", "conversations", "video", "shot_video-policy"],
)
def test_a_section_moved_to_the_runtime_names_where_it_went(
    tmp_path: Path, section: str, moved_to: str
) -> None:
    """后端不再认的段不是一句「Extra inputs are not permitted」，而是点名它和它在运行时配置里的位置。"""

    with pytest.raises(ValidationError, match=moved_to):
        load_runtime_config(write(tmp_path, VALID + section + "\n"))


def test_cors_wildcard_rejected(tmp_path: Path) -> None:
    bad = VALID.replace("security: {}", 'security: {cors_allow_origins: ["*"]}')
    with pytest.raises(ValidationError):
        load_runtime_config(write(tmp_path, bad))


def test_resolve_names_every_missing_variable_at_once(tmp_path: Path) -> None:

    config = load_runtime_config(write(tmp_path, VALID))
    with pytest.raises(ValidationError) as caught:
        resolve_settings(config)

    message = str(caught.value)
    assert "DATABASE_URL" in message
    assert "AUTH_SECRET" in message


def test_missing_credential_keys_name_the_variable(monkeypatch: pytest.MonkeyPatch) -> None:
    """后端运行不要这把钥匙；切换命令读它时缺了照样点名。"""

    with pytest.raises(ValidationError, match="CREDENTIAL_ENCRYPTION_KEYS"):
        CredentialKeysEnv()  # pyright: ignore[reportCallIssue]


@pytest.mark.parametrize(
    ("value", "reason"),
    [
        ("not-a-fernet-key", "第 1 个 key 不是合法的 Fernet key"),
        (f"{Fernet.generate_key().decode()},short", "第 2 个 key 不是合法的 Fernet key"),
        (f"{Fernet.generate_key().decode()},,", "第 2 个 key 是空的"),
    ],
)
def test_malformed_credential_keys_are_refused_without_echoing_them(
    monkeypatch: pytest.MonkeyPatch, value: str, reason: str
) -> None:
    monkeypatch.setenv("CREDENTIAL_ENCRYPTION_KEYS", value)

    with pytest.raises(ValidationError) as caught:
        CredentialKeysEnv()  # pyright: ignore[reportCallIssue]

    assert reason in str(caught.value.errors()[0]["msg"])
    printed = str(caught.value)
    for key in filter(None, value.split(",")):
        assert key not in printed


def test_credential_keys_keep_their_order(monkeypatch: pytest.MonkeyPatch) -> None:
    first, second = Fernet.generate_key().decode(), Fernet.generate_key().decode()
    monkeypatch.setenv("CREDENTIAL_ENCRYPTION_KEYS", f" {first} , {second} ")

    assert CredentialKeysEnv().key_list == (first, second)  # pyright: ignore[reportCallIssue]


def test_resolve_rejects_non_asyncpg_url_without_echoing_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = load_runtime_config(write(tmp_path, VALID))
    monkeypatch.setenv("DATABASE_URL", "postgresql://user:hunter2@db.test/iclip")
    monkeypatch.setenv("AUTH_SECRET", "s" * 32)
    with pytest.raises(ValidationError, match="asyncpg") as caught:
        resolve_settings(config)
    assert "hunter2" not in str(caught.value)


def test_resolve_rejects_short_secret(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    config = load_runtime_config(write(tmp_path, VALID))
    monkeypatch.setenv("DATABASE_URL", DB_URL)
    monkeypatch.setenv("AUTH_SECRET", "short")
    with pytest.raises(ValidationError, match="32"):
        resolve_settings(config)


def test_blank_value_counts_as_missing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:

    config = load_runtime_config(write(tmp_path, VALID))
    monkeypatch.setenv("DATABASE_URL", DB_URL)
    monkeypatch.setenv("AUTH_SECRET", "   ")
    with pytest.raises(ValidationError, match="AUTH_SECRET"):
        resolve_settings(config)


def test_a_missing_runtime_internal_token_fails_startup_naming_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """开跑检查在内部接口上：没有令牌每次运行都过不了，所以启动就失败。"""

    config = load_runtime_config(write(tmp_path, VALID))
    _core(monkeypatch)
    monkeypatch.delenv("RUNTIME_INTERNAL_TOKEN")

    with pytest.raises(ValidationError, match="RUNTIME_INTERNAL_TOKEN"):
        resolve_settings(config)


def test_a_short_runtime_internal_token_fails_startup_without_echoing_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = load_runtime_config(write(tmp_path, VALID))
    _core(monkeypatch)
    monkeypatch.setenv("RUNTIME_INTERNAL_TOKEN", "too-short-internal")

    with pytest.raises(ValidationError, match="RUNTIME_INTERNAL_TOKEN") as caught:
        resolve_settings(config)

    assert "32" in str(caught.value)
    assert "too-short-internal" not in str(caught.value)


def test_the_runtime_service_is_resolved_from_both_variables(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = load_runtime_config(write(tmp_path, VALID))
    _core(monkeypatch)
    monkeypatch.setenv("RUNTIME_URL", RUNTIME_URL + "/")

    resolved = resolve_settings(config).runtime_service

    assert (resolved.url, resolved.app_key) == (RUNTIME_URL, RUNTIME_KEY)


@pytest.mark.parametrize("missing", ["RUNTIME_URL", "RUNTIME_APP_KEY"])
def test_startup_fails_naming_a_missing_runtime_service_variable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, missing: str
) -> None:
    config = load_runtime_config(write(tmp_path, VALID))
    _core(monkeypatch)
    monkeypatch.delenv(missing)

    with pytest.raises(ValidationError, match=missing):
        resolve_settings(config)


@pytest.mark.parametrize(
    ("name", "written", "reason"),
    [
        ("RUNTIME_APP_KEY", "short-runtime-app-key", "32"),
        ("RUNTIME_URL", "runtime-without-scheme:7790", "http"),
    ],
    ids=["short-key", "not-http"],
)
def test_a_malformed_runtime_service_variable_fails_startup_without_echoing_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, name: str, written: str, reason: str
) -> None:
    config = load_runtime_config(write(tmp_path, VALID))
    _core(monkeypatch)
    monkeypatch.setenv(name, written)

    with pytest.raises(ValidationError, match=name) as caught:
        resolve_settings(config)

    assert reason in str(caught.value)
    assert written not in str(caught.value)


def test_optional_services_are_off_when_env_empty(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:

    config = load_runtime_config(write(tmp_path, VALID))
    _core(monkeypatch)
    settings = resolve_settings(config)
    assert settings.sso is None
    assert settings.media_generation is None
    assert settings.object_store is None
    assert settings.iclip_studio is None
    assert settings.product_catalog is None
    assert settings.whole_film_render is None
    assert not settings.shot_tools_enabled
    assert not settings.ffmpeg_required


def test_sso_on_requires_redirect(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    config = load_runtime_config(write(tmp_path, VALID))
    _core(monkeypatch)
    monkeypatch.setenv("SSO_BASE_URL", "https://sso.test")
    with pytest.raises(ValidationError, match="SSO_REDIRECT_URL"):
        resolve_settings(config)

    monkeypatch.setenv("SSO_REDIRECT_URL", "https://app.test/auth/sso/landing")
    monkeypatch.setenv("PMS_BASE_URL", "https://pms.test")
    resolved = resolve_settings(config)
    assert resolved.sso is not None
    assert resolved.sso.pms_base_url == "https://pms.test"
    assert resolved.sso.app_name == "iclip", "应用名来自 YAML，不是环境变量"


@pytest.mark.parametrize(
    "legacy",
    [
        "models:\n  qwen:\n    provider: alibaba\n    api_key_env: T_QWEN_KEY\n",
        "conversations:\n  title_model: qwen\n",
    ],
    ids=["models 段", "title_model"],
)
def test_the_model_settings_moved_to_the_database_are_refused(tmp_path: Path, legacy: str) -> None:
    """模型与标题模型改在库里配：旧 config.yaml 还留着这两处就启动失败，切换步骤先删掉它们。"""

    with pytest.raises(ValidationError):
        load_runtime_config(write(tmp_path, VALID + legacy))


MEDIA = """
media_generation:
  video:
    model: seedance
    allowed_models: [seedance, seedance-other]
  image:
    env: test
    text_to_image_task: text-to-image
    image_edit_task: image-edit
    default: nano_banana_pro
    models:
      nano_banana_pro:
        route: nano-banana-pro
        concurrency: 4
      gpt-image-2.5:
        route: openai/gpt-image-2.5-flare-developer
        concurrency: 2
        text_to_image_task: text-to-image
        image_edit_task: edit
"""

MEDIA_ENV = {
    "VIDEO_SUBMIT_URL": "https://video.test/generate",
    "VIDEO_STATUS_BASE_URL": "https://video.test/tasks",
    "VIDEO_API_KEY": "vk",
    "IMAGE_API_BASE": "https://image.test/gateway",
    "OSS_BUCKET": "iclip",
    "OSS_ENDPOINT": "https://oss.test",
    "OSS_ACCESS_KEY_ID": "ak",
    "OSS_ACCESS_KEY_SECRET": "sk",
    "OSS_PUBLIC_URL_BASE": "https://cdn.test",
}


@pytest.mark.parametrize("allowed", ["[]", "[other]", "[seedance, '   ']"])
def test_video_model_selection_rejects_invalid_configuration(tmp_path: Path, allowed: str) -> None:
    media = MEDIA.replace("[seedance, seedance-other]", allowed)
    with pytest.raises(ValidationError):
        load_runtime_config(write(tmp_path, VALID + media))


def _media_env(monkeypatch: pytest.MonkeyPatch) -> None:
    _core(monkeypatch)
    for name, value in MEDIA_ENV.items():
        monkeypatch.setenv(name, value)


def test_media_generation_off_when_submit_url_empty(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:

    config = load_runtime_config(write(tmp_path, VALID + MEDIA))
    _media_env(monkeypatch)
    monkeypatch.delenv("VIDEO_SUBMIT_URL")

    assert resolve_settings(config).media_generation is None


def test_media_generation_resolves_models_and_gateway_routes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = load_runtime_config(write(tmp_path, VALID + MEDIA))
    _media_env(monkeypatch)
    media = resolve_settings(config).media_generation

    assert media is not None
    assert media.video_model == "seedance", "对方的模型名来自 YAML"
    assert media.video_allowed_models == ("seedance", "seedance-other")
    assert [(model.name, model.api_base, model.concurrency) for model in media.image_models] == [
        ("nano_banana_pro", "https://image.test/gateway/nano-banana-pro", 4),
        ("gpt-image-2.5", "https://image.test/gateway/openai/gpt-image-2.5-flare-developer", 2),
    ], "网关根地址与声明的路由段在这一层拼好"
    assert [(model.text_to_image_task, model.image_edit_task) for model in media.image_models] == [
        (None, None),
        ("text-to-image", "edit"),
    ], "一家可以写自己的两条任务路由"
    assert (media.image_text_to_image_task, media.image_edit_task) == (
        "text-to-image",
        "image-edit",
    )


@pytest.mark.parametrize(
    "missing",
    ["VIDEO_STATUS_BASE_URL", "VIDEO_API_KEY", "IMAGE_API_BASE"],
)
def test_media_generation_half_configured_fails_loudly(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, missing: str
) -> None:

    config = load_runtime_config(write(tmp_path, VALID + MEDIA))
    _media_env(monkeypatch)
    monkeypatch.delenv(missing)
    with pytest.raises(ValidationError, match=missing):
        resolve_settings(config)


ENHANCE = """
    enhance:
      model: video-enhance
      resolutions: [1080p, 720p]
      fps: 30"""


def _with_enhance(enhance: str = ENHANCE) -> str:
    return VALID + MEDIA.replace(
        "allowed_models: [seedance, seedance-other]",
        "allowed_models: [seedance, seedance-other]" + enhance,
    )


def test_enhance_resolves_from_its_section_and_address(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = load_runtime_config(write(tmp_path, _with_enhance()))
    _media_env(monkeypatch)
    monkeypatch.setenv("VIDEO_ENHANCE_SUBMIT_URL", " https://video.test/videos/enhance/async ")
    media = resolve_settings(config).media_generation

    assert media is not None and media.video_enhance is not None
    enhance = media.video_enhance
    assert enhance.submit_url == "https://video.test/videos/enhance/async"
    assert (enhance.model, enhance.resolutions, enhance.fps) == (
        "video-enhance",
        ("1080p", "720p"),
        30,
    ), "档位保持配置里从高到低的先后"


def test_enhance_is_off_without_its_address(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = load_runtime_config(write(tmp_path, _with_enhance()))
    _media_env(monkeypatch)
    media = resolve_settings(config).media_generation

    assert media is not None and media.video_enhance is None


def test_enhance_address_without_its_section_fails_loudly(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = load_runtime_config(write(tmp_path, VALID + MEDIA))
    _media_env(monkeypatch)
    monkeypatch.setenv("VIDEO_ENHANCE_SUBMIT_URL", "https://video.test/videos/enhance/async")

    with pytest.raises(RuntimeError, match="VIDEO_ENHANCE_SUBMIT_URL"):
        resolve_settings(config)


@pytest.mark.parametrize(
    "enhance",
    [
        ENHANCE.replace("[1080p, 720p]", "[]"),
        ENHANCE.replace("[1080p, 720p]", "[1080p, 1080p]"),
        ENHANCE.replace("[1080p, 720p]", "[4k]"),
        ENHANCE.replace("fps: 30", "fps: 90"),
        ENHANCE.replace("model: video-enhance", "model: ''"),
    ],
    ids=["no_tiers", "repeated_tier", "unknown_tier", "fps_out_of_range", "no_model"],
)
def test_enhance_section_rejects_what_upstream_would(tmp_path: Path, enhance: str) -> None:
    with pytest.raises(ValidationError):
        load_runtime_config(write(tmp_path, _with_enhance(enhance)))


SUBTITLE = """  subtitle:
    url: https://asr.test/api/v1/services/aigc/multimodal-generation/generation
"""
MUSIC = """  music:
    url: https://music.test/api/v1/services/audio/tts/SpeechSynthesizer
"""


@pytest.mark.parametrize("key", [None, "", "   "], ids=["unset", "empty", "blank"])
def test_music_and_subtitles_are_off_without_the_shared_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, key: str | None
) -> None:
    config = load_runtime_config(write(tmp_path, VALID + MEDIA + SUBTITLE + MUSIC))
    _media_env(monkeypatch)
    if key is not None:
        monkeypatch.setenv("QWEN_API_KEY", key)
    media = resolve_settings(config).media_generation

    assert media is not None and media.subtitle is None and media.music is None


def test_the_shared_key_does_not_enable_absent_music_or_subtitles(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = load_runtime_config(write(tmp_path, VALID + MEDIA))
    _media_env(monkeypatch)
    monkeypatch.setenv("QWEN_API_KEY", "sk-qwen")
    media = resolve_settings(config).media_generation

    assert media is not None and media.subtitle is None and media.music is None


def test_music_and_subtitles_resolve_their_addresses_and_share_the_trimmed_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = load_runtime_config(write(tmp_path, VALID + MEDIA + SUBTITLE + MUSIC))
    _media_env(monkeypatch)
    monkeypatch.setenv("QWEN_API_KEY", " sk-qwen ")
    media = resolve_settings(config).media_generation

    assert media is not None and media.music is not None and media.subtitle is not None
    assert media.music.url == "https://music.test/api/v1/services/audio/tts/SpeechSynthesizer"
    assert (
        media.subtitle.url
        == "https://asr.test/api/v1/services/aigc/multimodal-generation/generation"
    )

    assert media.music.api_key == media.subtitle.api_key == "sk-qwen"


@pytest.mark.parametrize("missing", ["OSS_ENDPOINT", "OSS_ACCESS_KEY_ID", "OSS_PUBLIC_URL_BASE"])
def test_object_store_half_configured_fails_loudly(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, missing: str
) -> None:
    config = load_runtime_config(write(tmp_path, VALID))
    _media_env(monkeypatch)
    monkeypatch.delenv("VIDEO_SUBMIT_URL")
    monkeypatch.delenv(missing)
    with pytest.raises(ValidationError, match=missing):
        resolve_settings(config)


def test_media_generation_without_a_bucket_fails_loudly(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """生成结果依赖对象存储转存，缺少桶会留下可能过期的供应商地址。"""

    config = load_runtime_config(write(tmp_path, VALID + MEDIA))
    _media_env(monkeypatch)
    monkeypatch.delenv("OSS_BUCKET")
    with pytest.raises(RuntimeError, match="OSS_BUCKET"):
        resolve_settings(config)


def _bucket_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name, value in MEDIA_ENV.items():
        if name.startswith("OSS_"):
            monkeypatch.setenv(name, value)


def test_whole_film_render_is_off_until_its_url_is_set(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = load_runtime_config(write(tmp_path, VALID + MEDIA))
    _media_env(monkeypatch)
    assert resolve_settings(config).whole_film_render is None

    monkeypatch.setenv("WHOLE_FILM_RENDER_URL", " http://render:8080/ ")
    render = resolve_settings(config).whole_film_render
    assert render is not None and render.url == "http://render:8080"


def test_whole_film_render_without_a_bucket_or_media_generation_fails_loudly(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """每次导出是一条生成记录，成片上传进桶：没有桶、没开媒体生成都导不出来，报出缺的那一样。"""

    config = load_runtime_config(write(tmp_path, VALID))
    _core(monkeypatch)
    monkeypatch.setenv("WHOLE_FILM_RENDER_URL", "http://render:8080")
    with pytest.raises(RuntimeError, match="OSS_BUCKET") as neither:
        resolve_settings(config)
    assert "media_generation" in str(neither.value)

    _bucket_env(monkeypatch)
    with pytest.raises(RuntimeError, match="media_generation") as no_media:
        resolve_settings(config)
    assert "OSS_BUCKET" not in str(no_media.value)


@pytest.mark.parametrize("bad", ["render:8080", "ftp://render", "http://"])
def test_whole_film_render_url_must_be_http(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, bad: str
) -> None:
    config = load_runtime_config(write(tmp_path, VALID + MEDIA))
    _media_env(monkeypatch)
    monkeypatch.setenv("WHOLE_FILM_RENDER_URL", bad)
    with pytest.raises(ValidationError, match="WHOLE_FILM_RENDER_URL"):
        resolve_settings(config)


SHOT_VIDEO = """
shot_video: {}
"""

VIDEO_ENV = {
    "VIDEO_UNDERSTANDING_URL": "https://vision.test/responses",
    "VIDEO_UNDERSTANDING_API_KEY": "ark",
}


def test_shot_tools_enabled_when_generation_and_bucket_are_on(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = load_runtime_config(write(tmp_path, VALID + MEDIA + SHOT_VIDEO))
    _media_env(monkeypatch)
    settings = resolve_settings(config)

    assert settings.shot_video
    assert settings.shot_tools_missing == ()
    assert settings.shot_tools_enabled


def test_shot_video_without_media_generation_names_what_it_lacks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = load_runtime_config(write(tmp_path, VALID + MEDIA + SHOT_VIDEO))
    _media_env(monkeypatch)
    monkeypatch.delenv("VIDEO_SUBMIT_URL")
    settings = resolve_settings(config)

    assert settings.media_generation is None
    assert settings.shot_video
    assert settings.shot_tools_missing == ("VIDEO_SUBMIT_URL",)
    assert not settings.shot_tools_enabled


def test_shot_video_section_absent_means_off(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """没写 shot_video 段就不装取帧与出图，也不算缺东西。"""

    config = load_runtime_config(write(tmp_path, VALID + MEDIA))
    _media_env(monkeypatch)
    settings = resolve_settings(config)

    assert not settings.shot_video
    assert settings.shot_tools_missing == ()
    assert not settings.shot_tools_enabled


ICLIP_STUDIO = """
iclip_studio:
  breakdown_model: seed-omni
"""


def test_iclip_studio_resolves_with_the_video_understanding_credentials(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = load_runtime_config(write(tmp_path, VALID + ICLIP_STUDIO))
    _core(monkeypatch)
    for name, value in VIDEO_ENV.items():
        monkeypatch.setenv(name, value)
    settings = resolve_settings(config)

    assert settings.iclip_studio is not None
    assert settings.iclip_studio.breakdown_url == "https://vision.test/responses"
    assert settings.iclip_studio.breakdown_api_key == "ark"
    assert settings.iclip_studio.breakdown_model == "seed-omni", "对方的模型名来自 YAML"
    assert settings.ffmpeg_required, "读时长与抽帧都要 ffmpeg"


def test_iclip_studio_half_configured_fails_loudly(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = load_runtime_config(write(tmp_path, VALID + ICLIP_STUDIO))
    _core(monkeypatch)
    monkeypatch.setenv("VIDEO_UNDERSTANDING_URL", VIDEO_ENV["VIDEO_UNDERSTANDING_URL"])
    with pytest.raises(ValidationError, match="VIDEO_UNDERSTANDING_API_KEY"):
        resolve_settings(config)
