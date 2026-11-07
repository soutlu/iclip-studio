from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncEngine

from tests.helpers.app import TEST_CREDENTIAL_KEY
from tests.helpers.runtime_service import ADMIN_KEY, READER_KEY

VIDEO_KEY = ADMIN_KEY

CRM_KEY = READER_KEY

VIDEO_CODE = ("iclip", "iclip_video")

ENTRY_CONFIG = """\
apps:
  video:
    key_env: STUB_VIDEO_APP_KEY
    admin: true
    hooks: {gate: null, run_started: null, turn_started: null}
  crm:
    key_env: STUB_CRM_APP_KEY
    hooks: {gate: null, run_started: null, turn_started: null}
agent_runs:
  skill_cache_dir: SKILL_CACHE
ops:
  log_level: WARNING
"""

ENTRY_PROBE = f"""\
import asyncio, sys
import httpx
from agent_runtime.http.asgi import app_from_env

async def main():
    app = app_from_env()
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://runtime.test"
        ) as client:
            found = await client.get("/v1/agents", headers={{"Authorization": "Bearer {CRM_KEY}"}})
            assert found.status_code == 200, found.text

asyncio.run(main())
print("loaded:" + ",".join(sorted(
    name for name in sys.modules if name.split(".")[0] in {VIDEO_CODE!r}
)))
"""


async def test_the_runtime_entry_without_a_plugin_package_loads_no_video_code(
    engine: AsyncEngine, migrated_pg: str, tmp_path: Path
) -> None:
    config = tmp_path / "runtime.yaml"
    config.write_text(
        ENTRY_CONFIG.replace("SKILL_CACHE", str(tmp_path / "skills")), encoding="utf-8"
    )
    env = {
        **os.environ,
        "AGENT_RUNTIME_CONFIG": str(config),
        "DATABASE_URL": migrated_pg,
        "CREDENTIAL_ENCRYPTION_KEYS": TEST_CREDENTIAL_KEY,
        "STUB_VIDEO_APP_KEY": VIDEO_KEY,
        "STUB_CRM_APP_KEY": CRM_KEY,
    }
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        ENTRY_PROBE,
        cwd=tmp_path,
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=120)

    assert process.returncode == 0, stderr.decode(errors="replace")
    assert stdout.decode().strip().splitlines()[-1] == "loaded:"
