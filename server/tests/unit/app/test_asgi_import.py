from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from scripts.dump_openapi import PLACEHOLDER_ENV

SERVER_DIR = Path(__file__).resolve().parents[3]

UNREACHABLE_DATABASE = "postgresql+asyncpg://nobody:nothing@127.0.0.1:1/nowhere"

MINIMAL_CONFIG = """\
app: {name: iclip-test}
db: {schema: iclip}
security: {}
sso: {app_name: iclip}
"""


def _run_after_importing_the_app(tmp_path: Path, code: str) -> subprocess.CompletedProcess[str]:
    config = tmp_path / "config.yaml"
    config.write_text(MINIMAL_CONFIG, encoding="utf-8")
    env = {
        **{name: value for name, value in os.environ.items() if name not in PLACEHOLDER_ENV},
        "AUTH_SECRET": PLACEHOLDER_ENV["AUTH_SECRET"],
        "RUNTIME_URL": PLACEHOLDER_ENV["RUNTIME_URL"],
        "RUNTIME_APP_KEY": PLACEHOLDER_ENV["RUNTIME_APP_KEY"],
        "RUNTIME_INTERNAL_TOKEN": PLACEHOLDER_ENV["RUNTIME_INTERNAL_TOKEN"],
        "DATABASE_URL": UNREACHABLE_DATABASE,
        "CONFIG_FILE": str(config),
    }
    return subprocess.run(
        [sys.executable, "-c", f"import sys\nimport iclip.asgi\n{code}"],
        cwd=SERVER_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )


def test_importing_the_asgi_app_neither_connects_to_database_nor_loads_the_runtime(
    tmp_path: Path,
) -> None:
    done = _run_after_importing_the_app(
        tmp_path,
        "print(sorted(name for name in sys.modules"
        " if name.startswith(('agent_runtime', 'pydantic_ai'))))",
    )

    assert done.returncode == 0, done.stderr
    assert done.stdout.strip().splitlines()[-1] == "[]"
