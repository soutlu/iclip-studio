from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from iclip.config import (
    load_runtime_config,
    resolve_settings,
)

DB_URL = "postgresql+asyncpg://x"

MOVED_TO_CONFIG = {
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

MANIFEST = (
    *MOVED_TO_CONFIG,
    "DATABASE_URL",
    "AUTH_SECRET",
    "VIDEO_API_KEY",
    "OSS_ACCESS_KEY_ID",
    "OSS_ACCESS_KEY_SECRET",
    "PRODUCT_CATALOG_DATABASE_URL",
    "QWEN_SUBTITLE_API_KEY",
    "QWEN_MUSIC_API_KEY",
    "QWEN_SPEECH_API_KEY",
    "VIDEO_API_KEY_DEFAULT",
    "ASR_KEY_DEFAULT",
    "MUSIC_KEY_DEFAULT",
    "SPEECH_KEY_DEFAULT",
    "VIDEO_API_KEY_MKT",
    "QWEN_SUBTITLE_API_KEY_MKT",
    "QWEN_MUSIC_API_KEY_MKT",
    "QWEN_SPEECH_API_KEY_MKT",
    "VIDEO_API_KEY_ECOM",
    "RUNTIME_INTERNAL_TOKEN",
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
runtime: {url: "http://runtime:7790"}
ops: {log_level: INFO}
"""


def write(tmp_path: Path, content: str) -> Path:
    path = tmp_path / "config.yaml"
    path.write_text(content, encoding="utf-8")
    return path


RUNTIME_KEY = "runtime-app-key-for-config-tests-0123"
INTERNAL_TOKEN = "runtime-internal-token-for-config-0123"


def _core(monkeypatch: pytest.MonkeyPatch) -> None:

    monkeypatch.setenv("DATABASE_URL", DB_URL)
    monkeypatch.setenv("AUTH_SECRET", "s" * 32)
    monkeypatch.setenv("RUNTIME_APP_KEY", RUNTIME_KEY)
    monkeypatch.setenv("RUNTIME_INTERNAL_TOKEN", INTERNAL_TOKEN)


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


@pytest.mark.parametrize("missing", ["RUNTIME_APP_KEY", "RUNTIME_INTERNAL_TOKEN"])
def test_startup_fails_naming_a_missing_runtime_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, missing: str
) -> None:
    config = load_runtime_config(write(tmp_path, VALID))
    _core(monkeypatch)
    monkeypatch.delenv(missing)

    with pytest.raises(ValidationError, match=missing):
        resolve_settings(config)


@pytest.mark.parametrize("name", ["RUNTIME_APP_KEY", "RUNTIME_INTERNAL_TOKEN"])
def test_a_short_runtime_key_fails_startup_without_echoing_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, name: str
) -> None:
    config = load_runtime_config(write(tmp_path, VALID))
    _core(monkeypatch)
    monkeypatch.setenv(name, "too-short-runtime-key")

    with pytest.raises(ValidationError, match=name) as caught:
        resolve_settings(config)

    assert "32" in str(caught.value)
    assert "too-short-runtime-key" not in str(caught.value)


def test_the_runtime_section_is_required(tmp_path: Path) -> None:
    content = VALID.replace('runtime: {url: "http://runtime:7790"}\n', "")

    with pytest.raises(ValidationError, match="runtime"):
        load_runtime_config(write(tmp_path, content))


@pytest.mark.parametrize("bad", ["runtime-without-scheme:7790", "ftp://runtime", "http://", "''"])
def test_the_runtime_url_must_be_http(tmp_path: Path, bad: str) -> None:
    content = VALID.replace('"http://runtime:7790"', bad)

    with pytest.raises(ValidationError, match=r"runtime\.url"):
        load_runtime_config(write(tmp_path, content))


SSO = """
sso:
  app_name: iclip
  base_url: https://sso.example.test
  redirect_url: https://app.example.test/auth/sso/landing
"""

OBJECT_STORE = """
object_store:
  bucket: iclip
  endpoint: https://oss.example.test
  public_url_base: https://cdn.example.test
"""

OBJECT_STORE_KEYS = {"OSS_ACCESS_KEY_ID": "ak-test", "OSS_ACCESS_KEY_SECRET": "sk-test"}

MEDIA = """
media_generation:
  video:
    submit_url: https://video.example.test/generate
    status_base_url: https://video.example.test/tasks
    model: seedance
    allowed_models: [seedance, seedance-other]
  image:
    api_base: https://image.example.test/gateway
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

DEFAULT_GROUP = """  default:
    video_api_key_env: VIDEO_API_KEY_DEFAULT
    subtitle_api_key_env: ASR_KEY_DEFAULT
    music_api_key_env: MUSIC_KEY_DEFAULT
    speech_api_key_env: SPEECH_KEY_DEFAULT
    video_models:
      seedance: default-seedance
      seedance-other: default-seedance-other
"""

MKT_GROUP = """  mkt:
    video_api_key_env: VIDEO_API_KEY_MKT
    subtitle_api_key_env: QWEN_SUBTITLE_API_KEY_MKT
    music_api_key_env: QWEN_MUSIC_API_KEY_MKT
    speech_api_key_env: QWEN_SPEECH_API_KEY_MKT
    video_models:
      seedance: mkt-seedance
      seedance-other: mkt-seedance-other
"""

ECOM_GROUP = """  ecom:
    video_api_key_env: VIDEO_API_KEY_ECOM
    video_models:
      seedance: ecom-seedance
      seedance-other: ecom-seedance-other
"""


def groups(*entries: str) -> str:
    return "model_groups:\n" + "".join(entries)


DEFAULT = groups(DEFAULT_GROUP)

GROUPS = groups(DEFAULT_GROUP, MKT_GROUP, ECOM_GROUP)

MEDIA_ON = VALID + OBJECT_STORE + MEDIA

MEDIA_KEYS = {**OBJECT_STORE_KEYS, "VIDEO_API_KEY_DEFAULT": "vk-default"}


def _media_env(monkeypatch: pytest.MonkeyPatch) -> None:
    _core(monkeypatch)
    for name, value in MEDIA_KEYS.items():
        monkeypatch.setenv(name, value)


FULL = (
    VALID.replace('"http://runtime:7790"', '"http://runtime:7790/"')
    + SSO
    + """  pms_base_url: https://pms.example.test
  root_email: root@example.test
  oauth_name: corp_sso
"""
    + OBJECT_STORE
    + "  internal_endpoint: https://oss-internal.example.test\n"
    + MEDIA.replace(
        "allowed_models: [seedance, seedance-other]",
        """allowed_models: [seedance, seedance-other]
    enhance:
      submit_url: https://video.example.test/enhance
      model: video-enhance
      resolutions: [1080p]""",
    )
    + groups(
        DEFAULT_GROUP.replace(
            "seedance-other: default-seedance-other\n",
            "seedance-other: default-seedance-other\n      video-enhance: default-enhance\n",
        )
    )
    + """
final_cut:
  render_url: http://render:8080/
  preview_origin: https://preview.example.test/
"""
)


def test_every_address_and_name_is_read_from_the_config_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = load_runtime_config(write(tmp_path, FULL))
    _media_env(monkeypatch)

    settings = resolve_settings(config)

    sso = settings.sso
    assert sso is not None
    assert (
        sso.base_url,
        sso.redirect_url,
        sso.pms_base_url,
        sso.root_email,
        sso.oauth_name,
    ) == (
        "https://sso.example.test",
        "https://app.example.test/auth/sso/landing",
        "https://pms.example.test",
        "root@example.test",
        "corp_sso",
    )
    store = settings.object_store
    assert store is not None
    assert (store.bucket, store.endpoint, store.public_url_base, store.internal_endpoint) == (
        "iclip",
        "https://oss.example.test",
        "https://cdn.example.test",
        "https://oss-internal.example.test",
    )
    assert (store.access_key_id, store.access_key_secret) == ("ak-test", "sk-test")
    media = settings.media_generation
    assert media is not None
    assert (media.video_submit_url, media.video_status_base_url) == (
        "https://video.example.test/generate",
        "https://video.example.test/tasks",
    )
    assert media.video_enhance is not None
    assert media.video_enhance.submit_url == "https://video.example.test/enhance"
    assert [model.api_base for model in media.image_models] == [
        "https://image.example.test/gateway/nano-banana-pro",
        "https://image.example.test/gateway/openai/gpt-image-2.5-flare-developer",
    ]
    assert settings.final_cut_render is not None
    assert settings.final_cut_render.url == "http://render:8080"
    assert settings.final_cut_preview_origin == "https://preview.example.test"
    assert settings.runtime_service.url == "http://runtime:7790"
    assert settings.runtime_service.app_key == RUNTIME_KEY


def test_optional_features_are_off_when_their_sections_are_absent(
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
    assert settings.final_cut_preview_origin is None
    assert not settings.shot_tools_enabled
    assert not settings.ffmpeg_required


def test_the_sso_section_alone_turns_sso_on_with_defaults(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = load_runtime_config(write(tmp_path, VALID + SSO))
    _core(monkeypatch)

    sso = resolve_settings(config).sso

    assert sso is not None
    assert (sso.app_name, sso.pms_base_url, sso.root_email, sso.oauth_name) == (
        "iclip",
        None,
        None,
        "sso",
    )


@pytest.mark.parametrize("field", ["app_name", "base_url", "redirect_url"])
def test_an_sso_section_without_a_required_field_is_refused(tmp_path: Path, field: str) -> None:
    section = "\n".join(line for line in SSO.splitlines() if not line.startswith(f"  {field}:"))

    with pytest.raises(ValidationError, match=field):
        load_runtime_config(write(tmp_path, VALID + section + "\n"))


def test_the_object_store_section_turns_it_on_and_needs_both_keys(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = load_runtime_config(write(tmp_path, VALID + OBJECT_STORE))
    _core(monkeypatch)
    with pytest.raises(ValidationError) as caught:
        resolve_settings(config)
    assert "OSS_ACCESS_KEY_ID" in str(caught.value)
    assert "OSS_ACCESS_KEY_SECRET" in str(caught.value)

    for name, value in OBJECT_STORE_KEYS.items():
        monkeypatch.setenv(name, value)
    store = resolve_settings(config).object_store
    assert store is not None and store.internal_endpoint is None


@pytest.mark.parametrize("field", ["bucket", "endpoint", "public_url_base"])
def test_an_object_store_section_without_a_required_field_is_refused(
    tmp_path: Path, field: str
) -> None:
    section = "\n".join(
        line for line in OBJECT_STORE.splitlines() if not line.startswith(f"  {field}:")
    )

    with pytest.raises(ValidationError, match=field):
        load_runtime_config(write(tmp_path, VALID + section + "\n"))


@pytest.mark.parametrize("allowed", ["[]", "[other]", "[seedance, '   ']"])
def test_video_model_selection_rejects_invalid_configuration(tmp_path: Path, allowed: str) -> None:
    media = MEDIA.replace("[seedance, seedance-other]", allowed)
    with pytest.raises(ValidationError):
        load_runtime_config(write(tmp_path, VALID + media))


@pytest.mark.parametrize(
    "line",
    [
        "    submit_url: https://video.example.test/generate\n",
        "    status_base_url: https://video.example.test/tasks\n",
        "    api_base: https://image.example.test/gateway\n",
    ],
    ids=["submit_url", "status_base_url", "api_base"],
)
def test_a_media_generation_section_without_an_address_is_refused(
    tmp_path: Path, line: str
) -> None:
    with pytest.raises(ValidationError, match=line.split(":")[0].strip()):
        load_runtime_config(write(tmp_path, VALID + OBJECT_STORE + MEDIA.replace(line, "")))


def test_media_generation_without_an_object_store_fails_loudly(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = load_runtime_config(write(tmp_path, VALID + MEDIA + DEFAULT))
    _media_env(monkeypatch)
    with pytest.raises(RuntimeError, match="object_store"):
        resolve_settings(config)


ENHANCE = """
    enhance:
      submit_url: https://video.example.test/enhance
      model: video-enhance
      resolutions: [1080p, 720p]
      fps: 30"""


def _with_enhance(enhance: str = ENHANCE) -> str:
    return MEDIA_ON.replace(
        "allowed_models: [seedance, seedance-other]",
        "allowed_models: [seedance, seedance-other]" + enhance,
    )


def test_enhance_is_off_without_its_section(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = load_runtime_config(write(tmp_path, MEDIA_ON + DEFAULT))
    _media_env(monkeypatch)
    media = resolve_settings(config).media_generation

    assert media is not None and media.video_enhance is None


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


def test_an_enhance_section_without_its_address_names_it(tmp_path: Path) -> None:
    enhance = ENHANCE.replace("      submit_url: https://video.example.test/enhance\n", "")

    with pytest.raises(ValidationError, match="submit_url"):
        load_runtime_config(write(tmp_path, _with_enhance(enhance)))


SUBTITLE = """  subtitle:
    url: https://asr.example.test/api/v1/services/aigc/multimodal-generation/generation
"""
MUSIC = """  music:
    url: https://music.example.test/api/v1/services/audio/tts/SpeechSynthesizer
"""
SPEECH = """  speech:
    url: https://tts.example.test/api/v1/services/audio/tts/SpeechSynthesizer
"""


DEFAULT_QWEN_KEYS = {
    "ASR_KEY_DEFAULT": "asr-default",
    "MUSIC_KEY_DEFAULT": " music-default ",
    "SPEECH_KEY_DEFAULT": "dub-default",
}


@pytest.mark.parametrize(
    ("sections", "expected"),
    [
        ("", (None, None, None)),
        (SUBTITLE, ("asr-default", None, None)),
        (MUSIC, (None, "music-default", None)),
        (SPEECH, (None, None, "dub-default")),
        (SUBTITLE + MUSIC + SPEECH, ("asr-default", "music-default", "dub-default")),
    ],
    ids=["none", "subtitles-only", "music-only", "speech-only", "all"],
)
def test_subtitles_music_and_speech_each_turn_on_with_their_section(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    sections: str,
    expected: tuple[str | None, str | None, str | None],
) -> None:
    config = load_runtime_config(write(tmp_path, MEDIA_ON + sections + DEFAULT))
    _media_env(monkeypatch)
    for name, value in DEFAULT_QWEN_KEYS.items():
        monkeypatch.setenv(name, value)
    media = resolve_settings(config).media_generation

    assert media is not None
    assert tuple(
        service is not None for service in (media.subtitle, media.music, media.speech)
    ) == tuple(key is not None for key in expected)
    default = media.default_model_group
    assert (default.subtitle_api_key, default.music_api_key, default.speech_api_key) == expected


def test_the_speech_section_needs_only_its_address(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = load_runtime_config(write(tmp_path, MEDIA_ON + SPEECH + DEFAULT))
    _media_env(monkeypatch)
    monkeypatch.setenv("SPEECH_KEY_DEFAULT", "dub-default")
    media = resolve_settings(config).media_generation

    assert media is not None and media.speech is not None
    assert (
        media.speech.url,
        media.speech.concurrency,
        media.speech.timeout_seconds,
    ) == ("https://tts.example.test/api/v1/services/audio/tts/SpeechSynthesizer", 2, 120.0)


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
        load_runtime_config(write(tmp_path, MEDIA_ON + section))


FINAL_CUT_RENDER = """
final_cut:
  render_url: http://render:8080
"""


def test_final_cut_render_is_off_until_its_url_is_written(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _media_env(monkeypatch)
    config = load_runtime_config(write(tmp_path, MEDIA_ON + DEFAULT))
    assert resolve_settings(config).final_cut_render is None

    config = load_runtime_config(write(tmp_path, MEDIA_ON + DEFAULT + FINAL_CUT_RENDER))
    render = resolve_settings(config).final_cut_render
    assert render is not None and render.url == "http://render:8080"


def test_final_cut_render_without_an_object_store_or_media_generation_fails_loudly(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _media_env(monkeypatch)
    config = load_runtime_config(write(tmp_path, VALID + FINAL_CUT_RENDER))
    with pytest.raises(RuntimeError, match="object_store") as neither:
        resolve_settings(config)
    assert "media_generation" in str(neither.value)

    config = load_runtime_config(write(tmp_path, VALID + OBJECT_STORE + FINAL_CUT_RENDER))
    with pytest.raises(RuntimeError, match="media_generation") as no_media:
        resolve_settings(config)
    assert "object_store" not in str(no_media.value)


@pytest.mark.parametrize("bad", ["render:8080", "ftp://render", "http://"])
def test_final_cut_render_url_must_be_http(tmp_path: Path, bad: str) -> None:
    content = VALID + FINAL_CUT_RENDER.replace("http://render:8080", bad)

    with pytest.raises(ValidationError, match=r"final_cut\.render_url"):
        load_runtime_config(write(tmp_path, content))


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
    _core(monkeypatch)
    content = VALID + f'final_cut:\n  preview_origin: "{given}"\n'
    config = load_runtime_config(write(tmp_path, content))

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
def test_final_cut_preview_origin_must_be_http_host_and_port_only(tmp_path: Path, bad: str) -> None:
    content = VALID + f'final_cut:\n  preview_origin: "{bad}"\n'

    with pytest.raises(ValidationError, match=r"final_cut\.preview_origin"):
        load_runtime_config(write(tmp_path, content))


PRODUCT_CATALOG = """
product_catalog: {}
"""


def test_the_product_catalog_section_turns_it_on_and_needs_its_database_url(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _core(monkeypatch)
    config = load_runtime_config(write(tmp_path, VALID + PRODUCT_CATALOG))
    with pytest.raises(ValidationError, match="PRODUCT_CATALOG_DATABASE_URL"):
        resolve_settings(config)

    monkeypatch.setenv("PRODUCT_CATALOG_DATABASE_URL", "postgresql+asyncpg://pdm.example.test/pdm")
    catalog = resolve_settings(config).product_catalog
    assert catalog is not None
    assert catalog.database_url == "postgresql+asyncpg://pdm.example.test/pdm"


def test_a_product_catalog_url_without_its_section_fails_startup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _core(monkeypatch)
    monkeypatch.setenv("PRODUCT_CATALOG_DATABASE_URL", "postgresql+asyncpg://pdm.example.test/pdm")
    config = load_runtime_config(write(tmp_path, VALID))

    with pytest.raises(RuntimeError, match=r"PRODUCT_CATALOG_DATABASE_URL.*product_catalog: \{\}"):
        resolve_settings(config)


@pytest.mark.parametrize(("name", "path"), MOVED_TO_CONFIG.items())
def test_a_variable_moved_into_the_config_file_fails_startup_naming_its_new_place(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, name: str, path: str
) -> None:
    _core(monkeypatch)
    monkeypatch.setenv(name, "https://left-over.example.test")
    config = load_runtime_config(write(tmp_path, VALID))

    with pytest.raises(RuntimeError) as caught:
        resolve_settings(config)

    (line,) = str(caught.value).splitlines()
    assert name in line and path in line


def test_every_variable_moved_into_the_config_file_is_listed_at_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _core(monkeypatch)
    for name in MOVED_TO_CONFIG:
        monkeypatch.setenv(name, "https://left-over.example.test")
    config = load_runtime_config(write(tmp_path, VALID))

    with pytest.raises(RuntimeError) as caught:
        resolve_settings(config)

    lines = str(caught.value).splitlines()
    assert len(lines) == len(MOVED_TO_CONFIG)
    for line, (name, path) in zip(lines, MOVED_TO_CONFIG.items(), strict=True):
        assert name in line and path in line


@pytest.mark.parametrize("value", ["", "  "], ids=["empty", "blank"])
def test_an_empty_moved_variable_is_ignored(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    _core(monkeypatch)
    for name in MOVED_TO_CONFIG:
        monkeypatch.setenv(name, value)
    config = load_runtime_config(write(tmp_path, VALID))

    assert resolve_settings(config).runtime_service.url == "http://runtime:7790"


SHOT_VIDEO = """
shot_video: {}
"""


def test_shot_video_without_media_generation_names_what_it_lacks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = load_runtime_config(write(tmp_path, VALID + OBJECT_STORE + SHOT_VIDEO))
    _media_env(monkeypatch)
    settings = resolve_settings(config)

    assert settings.media_generation is None
    assert settings.shot_video
    assert settings.shot_tools_missing == ("media_generation",)
    assert not settings.shot_tools_enabled


def test_shot_video_section_absent_means_off(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = load_runtime_config(write(tmp_path, MEDIA_ON + DEFAULT))
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

    with pytest.raises(ValidationError, match=r"video 配置段已废弃.*请将其从后端配置文件中移除"):
        load_runtime_config(path)


def test_the_breakdown_model_is_no_longer_configured(tmp_path: Path) -> None:
    path = write(tmp_path, VALID + "iclip_studio:\n  breakdown_model: seed-omni\n")

    with pytest.raises(ValidationError, match="breakdown_model"):
        load_runtime_config(path)


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
    config = load_runtime_config(write(tmp_path, MEDIA_ON + GROUPS))
    _group_env(monkeypatch)

    settings = resolve_settings(config)

    assert settings.model_groups == ("mkt", "ecom"), "default 不是能选给人的组"
    media = settings.media_generation
    assert media is not None
    default = media.default_model_group
    assert (default.name, default.video_api_key, dict(default.video_models)) == (
        "default",
        "vk-default",
        {"seedance": "default-seedance", "seedance-other": "default-seedance-other"},
    )
    mkt, ecom = media.model_groups
    assert (mkt.name, mkt.video_api_key, dict(mkt.video_models)) == (
        "mkt",
        "vk-mkt",
        {"seedance": "mkt-seedance", "seedance-other": "mkt-seedance-other"},
    )
    assert (mkt.subtitle_api_key, mkt.music_api_key, mkt.speech_api_key) == (None, None, None), (
        "字幕、配乐、配音没开通"
    )
    assert (ecom.name, ecom.video_api_key) == ("ecom", "vk-ecom")


def test_the_default_group_is_left_out_of_the_choosable_groups_wherever_it_is_written(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    content = MEDIA_ON + groups(MKT_GROUP, DEFAULT_GROUP, ECOM_GROUP)
    config = load_runtime_config(write(tmp_path, content))
    _group_env(monkeypatch)

    settings = resolve_settings(config)

    assert settings.model_groups == ("mkt", "ecom")
    assert settings.media_generation is not None
    assert [group.name for group in settings.media_generation.model_groups] == ["mkt", "ecom"]


def test_only_the_default_group_leaves_nothing_to_choose(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = load_runtime_config(write(tmp_path, MEDIA_ON + DEFAULT))
    _media_env(monkeypatch)

    settings = resolve_settings(config)

    assert settings.model_groups == ()
    assert settings.media_generation is not None
    assert settings.media_generation.model_groups == ()


@pytest.mark.parametrize(
    "written",
    ["", groups(MKT_GROUP, ECOM_GROUP)],
    ids=["no_model_groups", "named_groups_only"],
)
def test_media_generation_without_the_default_group_fails_at_startup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, written: str
) -> None:
    config = load_runtime_config(write(tmp_path, MEDIA_ON + written))
    _group_env(monkeypatch)

    with pytest.raises(RuntimeError, match="model_groups 中缺少 default"):
        resolve_settings(config)


def test_group_keys_are_not_checked_while_media_generation_is_off(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = load_runtime_config(write(tmp_path, VALID + GROUPS))
    _core(monkeypatch)

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
    content = MEDIA_ON + GROUPS.replace(*change)

    with pytest.raises(ValidationError, match=message):
        load_runtime_config(write(tmp_path, content))


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (
            ("      seedance-other: ecom-seedance-other\n", ""),
            "model_groups.ecom.video_models 缺少 seedance-other",
        ),
        (
            ("seedance-other: ecom-seedance-other\n", "seedance-other: x\n      wan: y\n"),
            "model_groups.ecom.video_models 包含多余项 wan",
        ),
        (
            ("      seedance-other: default-seedance-other\n", ""),
            "model_groups.default.video_models 缺少 seedance-other",
        ),
        (
            ("seedance-other: default-seedance-other\n", "seedance-other: x\n      wan: y\n"),
            "model_groups.default.video_models 包含多余项 wan",
        ),
    ],
    ids=["missing_model", "unknown_model", "default_missing_model", "default_unknown_model"],
)
def test_video_models_must_cover_exactly_the_allowed_models(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, change: tuple[str, str], message: str
) -> None:
    config = load_runtime_config(write(tmp_path, MEDIA_ON + GROUPS.replace(*change)))
    _group_env(monkeypatch)

    with pytest.raises(RuntimeError, match=message):
        resolve_settings(config)


def test_video_models_must_also_name_the_enhance_model_once_enhance_is_on(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _group_env(monkeypatch)
    config = load_runtime_config(write(tmp_path, MEDIA_ON + GROUPS))
    assert resolve_settings(config).media_generation is not None, "高清版没开，不要求"

    config = load_runtime_config(write(tmp_path, _with_enhance() + GROUPS))
    with pytest.raises(
        RuntimeError, match=r"model_groups\.default\.video_models 缺少 video-enhance"
    ):
        resolve_settings(config)

    default_with_enhance = GROUPS.replace(
        "seedance-other: default-seedance-other\n",
        "seedance-other: default-seedance-other\n      video-enhance: default-enhance\n",
    )
    config = load_runtime_config(write(tmp_path, _with_enhance() + default_with_enhance))
    with pytest.raises(RuntimeError, match=r"model_groups\.mkt\.video_models 缺少 video-enhance"):
        resolve_settings(config)

    with_enhance = default_with_enhance.replace(
        "seedance-other: mkt-seedance-other\n",
        "seedance-other: mkt-seedance-other\n      video-enhance: mkt-enhance\n",
    ).replace(
        "seedance-other: ecom-seedance-other\n",
        "seedance-other: ecom-seedance-other\n      video-enhance: ecom-enhance\n",
    )
    config = load_runtime_config(write(tmp_path, _with_enhance() + with_enhance))
    media = resolve_settings(config).media_generation
    assert media is not None
    assert media.default_model_group.video_models["video-enhance"] == "default-enhance"
    assert media.model_groups[0].video_models["video-enhance"] == "mkt-enhance"


@pytest.mark.parametrize("value", [None, "", "  "], ids=["unset", "empty", "blank"])
@pytest.mark.parametrize(
    ("group", "env"),
    [("ecom", "VIDEO_API_KEY_ECOM"), ("default", "VIDEO_API_KEY_DEFAULT")],
    ids=["ecom", "default"],
)
def test_a_group_video_key_must_have_a_value(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, group: str, env: str, value: str | None
) -> None:
    config = load_runtime_config(write(tmp_path, MEDIA_ON + GROUPS))
    _group_env(monkeypatch)
    monkeypatch.delenv(env)
    if value is not None:
        monkeypatch.setenv(env, value)

    with pytest.raises(RuntimeError, match=rf"model_groups\.{group}\.video_api_key_env.*{env}"):
        resolve_settings(config)


@pytest.mark.parametrize(
    ("section", "field", "default_env", "group_env"),
    [
        (SUBTITLE, "subtitle_api_key_env", "ASR_KEY_DEFAULT", "QWEN_SUBTITLE_API_KEY_MKT"),
        (MUSIC, "music_api_key_env", "MUSIC_KEY_DEFAULT", "QWEN_MUSIC_API_KEY_MKT"),
        (SPEECH, "speech_api_key_env", "SPEECH_KEY_DEFAULT", "QWEN_SPEECH_API_KEY_MKT"),
    ],
    ids=["subtitle", "music", "speech"],
)
def test_once_a_qwen_service_is_on_every_group_needs_its_key(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    section: str,
    field: str,
    default_env: str,
    group_env: str,
) -> None:
    _group_env(monkeypatch)
    media_on = MEDIA_ON + section

    no_default_key = DEFAULT_GROUP.replace(f"    {field}: {default_env}\n", "")
    config = load_runtime_config(write(tmp_path, media_on + groups(no_default_key)))
    with pytest.raises(RuntimeError, match=f"model_groups.default.{field} 未配置"):
        resolve_settings(config)

    config = load_runtime_config(write(tmp_path, media_on + groups(DEFAULT_GROUP)))
    monkeypatch.setenv(default_env, " ")
    with pytest.raises(RuntimeError, match=f"model_groups.default.{field}.*{default_env}"):
        resolve_settings(config)

    monkeypatch.setenv(default_env, "sk-default")
    config = load_runtime_config(write(tmp_path, media_on + GROUPS))
    with pytest.raises(RuntimeError, match=f"model_groups.ecom.{field} 未配置"):
        resolve_settings(config)

    config = load_runtime_config(write(tmp_path, media_on + groups(DEFAULT_GROUP, MKT_GROUP)))
    monkeypatch.setenv(group_env, " ")
    with pytest.raises(RuntimeError, match=f"model_groups.mkt.{field}.*{group_env}"):
        resolve_settings(config)

    monkeypatch.setenv(group_env, "sk-mkt")
    media = resolve_settings(config).media_generation
    assert media is not None
    (mkt,) = media.model_groups
    for group, key in ((media.default_model_group, "sk-default"), (mkt, "sk-mkt")):
        keys = {
            "subtitle_api_key_env": group.subtitle_api_key,
            "music_api_key_env": group.music_api_key,
            "speech_api_key_env": group.speech_api_key,
        }
        assert keys == {name: key if name == field else None for name in keys}
