from __future__ import annotations

import httpx
import pytest

from iclip.app.bootstrap import build_app
from iclip.platform.media.codec import SOFTWARE
from tests.helpers.generation import MEDIA_ENVS, MemoryObjectStore, config_with_media


async def test_app_with_generation_starts_and_stops_cleanly(
    base_env: None, migrated_pg: str, monkeypatch: pytest.MonkeyPatch
) -> None:

    for name, value in MEDIA_ENVS.items():
        monkeypatch.setenv(name, value)

    app = build_app(config_with_media(), object_store=MemoryObjectStore(), media_codec=SOFTWARE)

    lifespan = app.router.lifespan_context(app)
    await lifespan.__aenter__()
    try:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            assert (await client.get("/healthz")).status_code == 200
            assert (await client.get("/generations")).status_code == 401, "路由挂上了"
    finally:
        await lifespan.__aexit__(None, None, None)
