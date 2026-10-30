"""import ``iclip.asgi`` 只建插件登记表与各个服务，不连库、不装配 agent：合同导出靠这一点，数据库连不上也
照样 import 得进来。"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from scripts.dump_openapi import PLACEHOLDER_ENV

SERVER_DIR = Path(__file__).resolve().parents[3]

UNREACHABLE_DATABASE = "postgresql+asyncpg://nobody:nothing@127.0.0.1:1/nowhere"
"""端口 1 上没有数据库：import 时只要试着连一次就会失败。"""

MINIMAL_CONFIG = """\
app: {name: iclip-test}
db: {schema: iclip}
security: {}
sso: {app_name: iclip}
"""


def test_importing_the_asgi_app_touches_no_database(tmp_path: Path) -> None:
    config = tmp_path / "config.yaml"
    config.write_text(MINIMAL_CONFIG, encoding="utf-8")
    env = {
        **{name: value for name, value in os.environ.items() if name not in PLACEHOLDER_ENV},
        "AUTH_SECRET": PLACEHOLDER_ENV["AUTH_SECRET"],
        "CREDENTIAL_ENCRYPTION_KEYS": PLACEHOLDER_ENV["CREDENTIAL_ENCRYPTION_KEYS"],
        "DATABASE_URL": UNREACHABLE_DATABASE,
        "CONFIG_FILE": str(config),
    }

    done = subprocess.run(
        [sys.executable, "-c", "import iclip.asgi"],
        cwd=SERVER_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )

    assert done.returncode == 0, done.stderr
