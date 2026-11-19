from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from iclip.config import (
    load_runtime_config,
    resolve_settings,
)

DB_URL = "postgresql+asyncpg://x"

MANIFEST = (
    "DATABASE_URL",
    "AUTH_SECRET",
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
    "PRODUCT_CATALOG_DATABASE_URL",
    "QWEN_SUBTITLE_API_KEY",
    "QWEN_MUSIC_API_KEY",
    "QWEN_SPEECH_API_KEY",
    "VIDEO_API_KEY_MKT",
    "QWEN_SUBTITLE_API_KEY_MKT",
    "QWEN_MUSIC_API_KEY_MKT",
    "QWEN_SPEECH_API_KEY_MKT",
    "VIDEO_API_KEY_ECOM",
    "FINAL_CUT_RENDER_URL",
    "FINAL_CUT_PREVIEW_ORIGIN",
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
    assert settings.final_cut_render is None
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
SPEECH = """  speech:
    url: https://tts.test/api/v1/services/audio/tts/SpeechSynthesizer
"""


@pytest.mark.parametrize(
    ("keys", "expected"),
    [
        ({}, (None, None, None)),
        (
            {
                "QWEN_SUBTITLE_API_KEY": "",
                "QWEN_MUSIC_API_KEY": "   ",
                "QWEN_SPEECH_API_KEY": " ",
            },
            (None, None, None),
        ),
        ({"QWEN_SUBTITLE_API_KEY": "sk-asr"}, ("sk-asr", None, None)),
        ({"QWEN_MUSIC_API_KEY": " sk-music "}, (None, "sk-music", None)),
        ({"QWEN_SPEECH_API_KEY": "sk-dub"}, (None, None, "sk-dub")),
        (
            {
                "QWEN_SUBTITLE_API_KEY": "sk-asr",
                "QWEN_MUSIC_API_KEY": "sk-music",
                "QWEN_SPEECH_API_KEY": "sk-dub",
            },
            ("sk-asr", "sk-music", "sk-dub"),
        ),
    ],
    ids=["unset", "blank", "subtitles-only", "music-only", "speech-only", "all"],
)
def test_subtitles_music_and_speech_each_turn_on_with_their_own_key(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    keys: dict[str, str],
    expected: tuple[str | None, str | None, str | None],
) -> None:
    config = load_runtime_config(write(tmp_path, VALID + MEDIA + SUBTITLE + MUSIC + SPEECH))
    _media_env(monkeypatch)
    for name, value in keys.items():
        monkeypatch.setenv(name, value)
    media = resolve_settings(config).media_generation

    assert media is not None
    resolved = tuple(
        None if service is None else service.api_key
        for service in (media.subtitle, media.music, media.speech)
    )
    assert resolved == expected


@pytest.mark.parametrize(
    ("sections", "enabled"),
    [
        ("", (False, False, False)),
        (SUBTITLE, (True, False, False)),
        (MUSIC, (False, True, False)),
        (SPEECH, (False, False, True)),
    ],
    ids=["none-configured", "subtitles-only", "music-only", "speech-only"],
)
def test_a_key_enables_only_a_configured_service(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    sections: str,
    enabled: tuple[bool, bool, bool],
) -> None:
    config = load_runtime_config(write(tmp_path, VALID + MEDIA + sections))
    _media_env(monkeypatch)
    monkeypatch.setenv("QWEN_SUBTITLE_API_KEY", "sk-asr")
    monkeypatch.setenv("QWEN_MUSIC_API_KEY", "sk-music")
    monkeypatch.setenv("QWEN_SPEECH_API_KEY", "sk-dub")
    media = resolve_settings(config).media_generation

    assert media is not None
    assert (
        media.subtitle is not None,
        media.music is not None,
        media.speech is not None,
    ) == enabled


def test_the_speech_section_needs_only_its_address(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = load_runtime_config(write(tmp_path, VALID + MEDIA + SPEECH))
    _media_env(monkeypatch)
    monkeypatch.setenv("QWEN_SPEECH_API_KEY", "sk-dub")
    media = resolve_settings(config).media_generation

    assert media is not None and media.speech is not None
    assert (
        media.speech.url,
        media.speech.api_key,
        media.speech.concurrency,
        media.speech.timeout_seconds,
    ) == ("https://tts.test/api/v1/services/audio/tts/SpeechSynthesizer", "sk-dub", 2, 120.0)


@pytest.mark.parametrize(
    "section",
    [
        "  speech: {url: ''}\n",
        "  speech: {}\n",
        SPEECH + "    concurrency: 0\n",
        SPEECH + "    timeout_seconds: 0\n",
    ],
    ids=["empty-url", "no-url", "no-concurrency", "no-timeout"],
)
def test_the_speech_section_rejects_unusable_values(tmp_path: Path, section: str) -> None:
    with pytest.raises(ValidationError):
        load_runtime_config(write(tmp_path, VALID + MEDIA + section))


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
    config = load_runtime_config(write(tmp_path, VALID + MEDIA))
    _media_env(monkeypatch)
    monkeypatch.delenv("OSS_BUCKET")
    with pytest.raises(RuntimeError, match="OSS_BUCKET"):
        resolve_settings(config)


def _bucket_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name, value in MEDIA_ENV.items():
        if name.startswith("OSS_"):
            monkeypatch.setenv(name, value)


def test_final_cut_render_is_off_until_its_url_is_set(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = load_runtime_config(write(tmp_path, VALID + MEDIA))
    _media_env(monkeypatch)
    assert resolve_settings(config).final_cut_render is None

    monkeypatch.setenv("FINAL_CUT_RENDER_URL", " http://render:8080/ ")
    render = resolve_settings(config).final_cut_render
    assert render is not None and render.url == "http://render:8080"


def test_final_cut_render_without_a_bucket_or_media_generation_fails_loudly(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = load_runtime_config(write(tmp_path, VALID))
    _core(monkeypatch)
    monkeypatch.setenv("FINAL_CUT_RENDER_URL", "http://render:8080")
    with pytest.raises(RuntimeError, match="OSS_BUCKET") as neither:
        resolve_settings(config)
    assert "media_generation" in str(neither.value)

    _bucket_env(monkeypatch)
    with pytest.raises(RuntimeError, match="media_generation") as no_media:
        resolve_settings(config)
    assert "OSS_BUCKET" not in str(no_media.value)


@pytest.mark.parametrize("bad", ["render:8080", "ftp://render", "http://"])
def test_final_cut_render_url_must_be_http(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, bad: str
) -> None:
    config = load_runtime_config(write(tmp_path, VALID + MEDIA))
    _media_env(monkeypatch)
    monkeypatch.setenv("FINAL_CUT_RENDER_URL", bad)
    with pytest.raises(ValidationError, match="FINAL_CUT_RENDER_URL"):
        resolve_settings(config)


@pytest.mark.parametrize(
    ("given", "resolved"),
    [
        ("https://preview.app.example.com", "https://preview.app.example.com"),
        (" http://preview.localhost:3014/ ", "http://preview.localhost:3014"),
    ],
)
def test_final_cut_preview_origin_is_read_as_a_bare_origin(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, given: str, resolved: str
) -> None:
    config = load_runtime_config(write(tmp_path, VALID))
    _core(monkeypatch)
    assert resolve_settings(config).final_cut_preview_origin is None

    monkeypatch.setenv("FINAL_CUT_PREVIEW_ORIGIN", given)
    assert resolve_settings(config).final_cut_preview_origin == resolved


@pytest.mark.parametrize(
    "bad",
    [
        "preview.app.example.com",
        "ftp://preview.app.example.com",
        "https://preview.app.example.com/api",
        "https://preview.app.example.com?x=1",
        "https://user@preview.app.example.com",
        "https://preview.app.example.com:port",
        "null",
    ],
)
def test_final_cut_preview_origin_must_be_http_host_and_port_only(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, bad: str
) -> None:
    config = load_runtime_config(write(tmp_path, VALID))
    _core(monkeypatch)
    monkeypatch.setenv("FINAL_CUT_PREVIEW_ORIGIN", bad)
    with pytest.raises(ValidationError, match="FINAL_CUT_PREVIEW_ORIGIN"):
        resolve_settings(config)


SHOT_VIDEO = """
shot_video: {}
"""


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
    config = load_runtime_config(write(tmp_path, VALID + MEDIA))
    _media_env(monkeypatch)
    settings = resolve_settings(config)

    assert not settings.shot_video
    assert settings.shot_tools_missing == ()
    assert not settings.shot_tools_enabled


@pytest.mark.parametrize(
    ("section", "concurrency"),
    [("iclip_studio: {}\n", None), ("iclip_studio:\n  breakdown_concurrency: 3\n", 3)],
    ids=["empty", "concurrency"],
)
def test_the_iclip_studio_section_alone_turns_breakdown_on(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, section: str, concurrency: int | None
) -> None:
    config = load_runtime_config(write(tmp_path, VALID + section))
    _core(monkeypatch)

    settings = resolve_settings(config)

    assert settings.iclip_studio is not None
    assert settings.iclip_studio.breakdown_concurrency == concurrency


def test_an_old_video_section_says_to_delete_it(tmp_path: Path) -> None:
    path = write(tmp_path, VALID + "video:\n  understanding_model: seed-vision\n")

    with pytest.raises(ValidationError, match=r"video 段已不用.*从后端的配置文件里删掉它"):
        load_runtime_config(path)


def test_the_breakdown_model_is_no_longer_configured(tmp_path: Path) -> None:
    path = write(tmp_path, VALID + "iclip_studio:\n  breakdown_model: seed-omni\n")

    with pytest.raises(ValidationError, match="breakdown_model"):
        load_runtime_config(path)


GROUPS = """
model_groups:
  mkt:
    video_api_key_env: VIDEO_API_KEY_MKT
    subtitle_api_key_env: QWEN_SUBTITLE_API_KEY_MKT
    music_api_key_env: QWEN_MUSIC_API_KEY_MKT
    speech_api_key_env: QWEN_SPEECH_API_KEY_MKT
    video_models:
      seedance: mkt-seedance
      seedance-other: mkt-seedance-other
  ecom:
    video_api_key_env: VIDEO_API_KEY_ECOM
    video_models:
      seedance: ecom-seedance
      seedance-other: ecom-seedance-other
"""

GROUP_KEYS = {
    "VIDEO_API_KEY_MKT": "vk-mkt",
    "QWEN_SUBTITLE_API_KEY_MKT": "asr-mkt",
    "QWEN_MUSIC_API_KEY_MKT": "music-mkt",
    "QWEN_SPEECH_API_KEY_MKT": "dub-mkt",
    "VIDEO_API_KEY_ECOM": "vk-ecom",
}


def _group_env(monkeypatch: pytest.MonkeyPatch) -> None:
    _media_env(monkeypatch)
    for name, value in GROUP_KEYS.items():
        monkeypatch.setenv(name, value)


def test_model_groups_resolve_in_config_order_with_their_keys(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = load_runtime_config(write(tmp_path, VALID + MEDIA + GROUPS))
    _group_env(monkeypatch)

    settings = resolve_settings(config)

    assert settings.model_groups == ("mkt", "ecom")
    assert settings.media_generation is not None
    mkt, ecom = settings.media_generation.model_groups
    assert (mkt.name, mkt.video_api_key, dict(mkt.video_models)) == (
        "mkt",
        "vk-mkt",
        {"seedance": "mkt-seedance", "seedance-other": "mkt-seedance-other"},
    )
    assert (mkt.subtitle_api_key, mkt.music_api_key, mkt.speech_api_key) == (None, None, None), (
        "字幕、配乐、配音没开通"
    )
    assert (ecom.name, ecom.video_api_key) == ("ecom", "vk-ecom")


def test_no_model_groups_section_means_no_groups(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = load_runtime_config(write(tmp_path, VALID + MEDIA))
    _media_env(monkeypatch)

    settings = resolve_settings(config)

    assert settings.model_groups == ()
    assert settings.media_generation is not None
    assert settings.media_generation.model_groups == ()


def test_group_keys_are_not_checked_while_media_generation_is_off(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = load_runtime_config(write(tmp_path, VALID + MEDIA + GROUPS))
    _media_env(monkeypatch)
    monkeypatch.delenv("VIDEO_SUBMIT_URL")

    settings = resolve_settings(config)

    assert settings.media_generation is None
    assert settings.model_groups == ("mkt", "ecom")


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (("  mkt:\n", "  Mkt:\n"), "Mkt"),
        (("  mkt:\n", "  1mkt:\n"), "1mkt"),
        (("  mkt:\n", "  mkt-a:\n"), "mkt-a"),
        (("seedance: ecom-seedance\n", "seedance: ''\n"), "seedance"),
        (("    video_api_key_env: VIDEO_API_KEY_ECOM\n", ""), "video_api_key_env"),
    ],
    ids=["upper_case", "leading_digit", "dash", "empty_model", "no_video_key"],
)
def test_malformed_model_groups_are_refused_naming_what_is_wrong(
    tmp_path: Path, change: tuple[str, str], message: str
) -> None:
    content = VALID + MEDIA + GROUPS.replace(*change)

    with pytest.raises(ValidationError, match=message):
        load_runtime_config(write(tmp_path, content))


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (
            ("      seedance-other: ecom-seedance-other\n", ""),
            "model_groups.ecom.video_models 缺 seedance-other",
        ),
        (
            ("seedance-other: ecom-seedance-other\n", "seedance-other: x\n      wan: y\n"),
            "model_groups.ecom.video_models 多了 wan",
        ),
    ],
    ids=["missing_model", "unknown_model"],
)
def test_video_models_must_cover_exactly_the_allowed_models(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, change: tuple[str, str], message: str
) -> None:
    config = load_runtime_config(write(tmp_path, VALID + MEDIA + GROUPS.replace(*change)))
    _group_env(monkeypatch)

    with pytest.raises(RuntimeError, match=message):
        resolve_settings(config)


def test_video_models_must_also_name_the_enhance_model_once_enhance_is_on(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = load_runtime_config(write(tmp_path, _with_enhance() + GROUPS))
    _group_env(monkeypatch)
    assert resolve_settings(config).media_generation is not None, "高清版没开，不要求"

    monkeypatch.setenv("VIDEO_ENHANCE_SUBMIT_URL", "https://video.test/videos/enhance/async")
    with pytest.raises(RuntimeError, match=r"model_groups\.mkt\.video_models 缺 video-enhance"):
        resolve_settings(config)

    with_enhance = GROUPS.replace(
        "seedance-other: mkt-seedance-other\n",
        "seedance-other: mkt-seedance-other\n      video-enhance: mkt-enhance\n",
    ).replace(
        "seedance-other: ecom-seedance-other\n",
        "seedance-other: ecom-seedance-other\n      video-enhance: ecom-enhance\n",
    )
    config = load_runtime_config(write(tmp_path, _with_enhance() + with_enhance))
    media = resolve_settings(config).media_generation
    assert media is not None
    assert media.model_groups[0].video_models["video-enhance"] == "mkt-enhance"


@pytest.mark.parametrize("value", [None, "", "  "], ids=["unset", "empty", "blank"])
def test_a_group_video_key_must_have_a_value(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, value: str | None
) -> None:
    config = load_runtime_config(write(tmp_path, VALID + MEDIA + GROUPS))
    _group_env(monkeypatch)
    monkeypatch.delenv("VIDEO_API_KEY_ECOM")
    if value is not None:
        monkeypatch.setenv("VIDEO_API_KEY_ECOM", value)

    with pytest.raises(
        RuntimeError, match=r"model_groups\.ecom\.video_api_key_env.*VIDEO_API_KEY_ECOM"
    ):
        resolve_settings(config)


@pytest.mark.parametrize(
    ("section", "default_key", "field", "group_env"),
    [
        (SUBTITLE, "QWEN_SUBTITLE_API_KEY", "subtitle_api_key_env", "QWEN_SUBTITLE_API_KEY_MKT"),
        (MUSIC, "QWEN_MUSIC_API_KEY", "music_api_key_env", "QWEN_MUSIC_API_KEY_MKT"),
        (SPEECH, "QWEN_SPEECH_API_KEY", "speech_api_key_env", "QWEN_SPEECH_API_KEY_MKT"),
    ],
    ids=["subtitle", "music", "speech"],
)
def test_once_a_qwen_service_is_on_every_group_needs_its_key(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    section: str,
    default_key: str,
    field: str,
    group_env: str,
) -> None:
    config = load_runtime_config(write(tmp_path, VALID + MEDIA + section + GROUPS))
    _group_env(monkeypatch)
    monkeypatch.setenv(default_key, "sk-default")

    with pytest.raises(RuntimeError, match=f"model_groups.ecom.{field} 没写"):
        resolve_settings(config)

    only_mkt = GROUPS.split("  ecom:")[0]
    config = load_runtime_config(write(tmp_path, VALID + MEDIA + section + only_mkt))
    monkeypatch.setenv(group_env, " ")
    with pytest.raises(RuntimeError, match=f"model_groups.mkt.{field}.*{group_env}"):
        resolve_settings(config)

    monkeypatch.setenv(group_env, "sk-mkt")
    media = resolve_settings(config).media_generation
    assert media is not None
    (mkt,) = media.model_groups
    keys = {
        "subtitle_api_key_env": mkt.subtitle_api_key,
        "music_api_key_env": mkt.music_api_key,
        "speech_api_key_env": mkt.speech_api_key,
    }
    assert keys == {name: "sk-mkt" if name == field else None for name in keys}
