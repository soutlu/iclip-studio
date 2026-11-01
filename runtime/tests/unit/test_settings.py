"""运行时服务的配置：YAML 给应用名单与运行参数，环境变量给连接串、加密钥匙与各应用的密钥；缺了或不对都在
启动时报错，报错不带机密。"""

from __future__ import annotations

import base64
from collections.abc import Mapping
from contextlib import AbstractAsyncContextManager
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from agent_runtime.settings import (
    load_config,
    resolve_settings,
)

DATABASE_URL = "postgresql+asyncpg://user:pass@db.test:5432/runtime"
FERNET_KEY = base64.urlsafe_b64encode(b"settings-test-key-0123456789abcd").decode()
OTHER_FERNET_KEY = base64.urlsafe_b64encode(b"settings-test-key-abcdefghijklmn").decode()
BFF_KEY = "b" * 40
TOOL_KEY = "t" * 40
HOOK_TOKEN = "h" * 40

YAML = """
apps:
  bff:
    key_env: RUNTIME_KEY_BFF
    admin: true
    hooks:
      token_env: RUNTIME_HOOK_TOKEN
      gate: https://bff.test/hooks/gate
      run_started: https://bff.test/hooks/run-started
      turn_started: null
      timeout_seconds: 2.5
  tool:
    key_env: RUNTIME_KEY_TOOL
    hooks:
      gate: null
      run_started: null
      turn_started: null
agent_runs:
  heartbeat_seconds: 5
  lease_seconds: 20
compaction:
  keep_messages: 8
ops:
  log_format: json
"""


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> pytest.MonkeyPatch:
    monkeypatch.setenv("DATABASE_URL", DATABASE_URL)
    monkeypatch.setenv("CREDENTIAL_ENCRYPTION_KEYS", f"{FERNET_KEY}, {OTHER_FERNET_KEY}")
    monkeypatch.setenv("RUNTIME_KEY_BFF", BFF_KEY)
    monkeypatch.setenv("RUNTIME_KEY_TOOL", TOOL_KEY)
    monkeypatch.setenv("RUNTIME_HOOK_TOKEN", HOOK_TOKEN)
    return monkeypatch


def write_config(tmp_path: Path, text: str = YAML) -> Path:
    path = tmp_path / "config.yaml"
    path.write_text(text, encoding="utf-8")
    return path


def test_the_yaml_file_ignores_environment_variables(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("APPS", '{"x": {"key_env": "X"}}')

    config = load_config(write_config(tmp_path, f"apps:\n  bff:\n    key_env: K\n{NO_HOOKS}"))

    assert list(config.apps) == ["bff"]


NO_HOOKS = "    hooks: {gate: null, run_started: null, turn_started: null}\n"
"""一个应用不要任何回调时的写法：三个键都写、都为 null。"""


@pytest.mark.parametrize(
    "text",
    [
        "apps: {}\n",
        "agent_runs: {}\n",
        f"apps:\n  Bad_Id:\n    key_env: K\n{NO_HOOKS}",
        f"apps:\n  bff:\n    key_env: lower_case\n{NO_HOOKS}",
        f"apps:\n  bff:\n    key_env: K\n    colour: red\n{NO_HOOKS}",
        f"apps:\n  bff:\n    key_env: K\n{NO_HOOKS}webhooks: {{}}\n",
        f"apps:\n  bff:\n    key_env: K\n{NO_HOOKS}"
        "agent_runs:\n  heartbeat_seconds: 30\n  lease_seconds: 30\n",
        # 回调：整段不写、少写一个键、有地址没令牌、地址不是 http(s)、超时不是正数。
        "apps:\n  bff:\n    key_env: K\n",
        "apps:\n  bff:\n    key_env: K\n    hooks: {gate: null, run_started: null}\n",
        "apps:\n  bff:\n    key_env: K\n"
        "    hooks: {gate: 'https://bff.test/g', run_started: null, turn_started: null}\n",
        "apps:\n  bff:\n    key_env: K\n    hooks: {token_env: T, gate: 'ftp://bff.test/g',"
        " run_started: null, turn_started: null}\n",
        "apps:\n  bff:\n    key_env: K\n    hooks: {gate: null, run_started: null,"
        " turn_started: null, timeout_seconds: 0}\n",
    ],
)
def test_malformed_yaml_fails_validation(tmp_path: Path, text: str) -> None:
    with pytest.raises(ValidationError):
        load_config(write_config(tmp_path, text))


def plugin_factory(config: Mapping[str, Any]) -> AbstractAsyncContextManager[None]:
    """``plugins.factory`` 指向的入口替身；读配置不调它。"""

    raise AssertionError(f"读配置时不该调插件包入口：{config}")


@pytest.mark.parametrize(
    "plugins",
    [
        "plugins: {config: {}}\n",
        "plugins: {factory: 'no_such_module:build'}\n",
        "plugins: {factory: 'tests.unit.test_settings:no_such_factory'}\n",
        "plugins: {factory: 'tests.unit.test_settings:plugin_factory', extra: 1}\n",
    ],
    ids=["no-factory", "unknown-module", "unknown-callable", "unknown-key"],
)
def test_a_malformed_plugins_section_fails_validation(tmp_path: Path, plugins: str) -> None:
    with pytest.raises(ValidationError):
        load_config(write_config(tmp_path, f"apps:\n  bff:\n    key_env: K\n{NO_HOOKS}{plugins}"))


def test_missing_or_empty_config_file_fails(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        load_config(tmp_path / "missing.yaml")
    with pytest.raises(ValueError, match="为空"):
        load_config(write_config(tmp_path, ""))


def test_database_url_must_be_asyncpg_and_the_error_hides_it(
    tmp_path: Path, env: pytest.MonkeyPatch
) -> None:
    env.setenv("DATABASE_URL", "postgresql://user:hunter2@db.test/runtime")

    with pytest.raises(ValidationError, match="asyncpg") as caught:
        resolve_settings(load_config(write_config(tmp_path)))
    assert "hunter2" not in str(caught.value)


@pytest.mark.parametrize(
    ("value", "reason"),
    [
        ("not-a-secret-key", "第 1 个 key 不是合法的 Fernet key"),
        (f"{FERNET_KEY},not-a-secret-key", "第 2 个 key 不是合法的 Fernet key"),
        (f"{FERNET_KEY},,", "第 2 个 key 是空的"),
    ],
    ids=["first-malformed", "second-malformed", "empty"],
)
def test_credential_keys_must_be_fernet_keys_and_the_error_hides_them(
    tmp_path: Path, env: pytest.MonkeyPatch, value: str, reason: str
) -> None:
    env.setenv("CREDENTIAL_ENCRYPTION_KEYS", value)

    with pytest.raises(ValidationError, match=reason) as caught:
        resolve_settings(load_config(write_config(tmp_path)))
    assert "not-a-secret-key" not in str(caught.value)


@pytest.mark.parametrize("missing", ["DATABASE_URL", "CREDENTIAL_ENCRYPTION_KEYS"])
def test_required_env_must_be_set(tmp_path: Path, env: pytest.MonkeyPatch, missing: str) -> None:
    env.delenv(missing)

    with pytest.raises(ValidationError):
        resolve_settings(load_config(write_config(tmp_path)))


def test_an_app_key_must_be_set(tmp_path: Path, env: pytest.MonkeyPatch) -> None:
    env.delenv("RUNTIME_KEY_TOOL")

    with pytest.raises(RuntimeError, match="RUNTIME_KEY_TOOL"):
        resolve_settings(load_config(write_config(tmp_path)))


def test_an_app_key_must_be_long_enough(tmp_path: Path, env: pytest.MonkeyPatch) -> None:
    env.setenv("RUNTIME_KEY_TOOL", "short-key")

    with pytest.raises(RuntimeError, match="≥ 32") as caught:
        resolve_settings(load_config(write_config(tmp_path)))
    assert "short-key" not in str(caught.value)


def test_two_apps_cannot_share_a_key(tmp_path: Path, env: pytest.MonkeyPatch) -> None:
    env.setenv("RUNTIME_KEY_TOOL", BFF_KEY)

    with pytest.raises(RuntimeError, match="同一把密钥") as caught:
        resolve_settings(load_config(write_config(tmp_path)))
    assert BFF_KEY not in str(caught.value)


def test_a_hook_token_must_be_set(tmp_path: Path, env: pytest.MonkeyPatch) -> None:
    env.delenv("RUNTIME_HOOK_TOKEN")

    with pytest.raises(RuntimeError, match="RUNTIME_HOOK_TOKEN"):
        resolve_settings(load_config(write_config(tmp_path)))


def test_a_hook_token_must_be_long_enough_and_the_error_hides_it(
    tmp_path: Path, env: pytest.MonkeyPatch
) -> None:
    env.setenv("RUNTIME_HOOK_TOKEN", "short-token")

    with pytest.raises(RuntimeError, match="≥ 32") as caught:
        resolve_settings(load_config(write_config(tmp_path)))
    assert "short-token" not in str(caught.value)


def test_the_hook_token_stays_out_of_the_settings_repr(
    tmp_path: Path, env: pytest.MonkeyPatch
) -> None:
    settings = resolve_settings(load_config(write_config(tmp_path)))

    assert HOOK_TOKEN not in repr(settings.apps)


def test_an_app_without_hook_urls_reads_no_token(tmp_path: Path, env: pytest.MonkeyPatch) -> None:
    """三个地址都为 null 时不读令牌：令牌环境变量写了也不要求它存在。"""

    text = YAML.replace(
        "    hooks:\n      gate: null\n",
        "    hooks:\n      token_env: RUNTIME_TOOL_TOKEN\n      gate: null\n",
    )
    settings = resolve_settings(load_config(write_config(tmp_path, text)))

    assert settings.apps[1].hooks is None
