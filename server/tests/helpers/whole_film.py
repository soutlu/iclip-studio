from __future__ import annotations

import pytest
from fastapi import FastAPI
from procrastinate.testing import InMemoryConnector
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.platform.media.codec import SOFTWARE
from tests.helpers.agents import CONVERSABLE_SEEDS, seed_agents
from tests.helpers.generation import MEDIA_ENVS, config_with_media
from tests.helpers.model_providers import GOOD_KEY, KeyCheckingProbe
from tests.helpers.render import StubRender
from tests.helpers.runtime_backed import build_backed_app, config_services_of

RENDER_ENVS = {
    **MEDIA_ENVS,
    "OSS_INTERNAL_ENDPOINT": "https://oss-ap-southeast-1-internal.aliyuncs.com",
}


async def build_whole_film_app(
    monkeypatch: pytest.MonkeyPatch,
    engine: AsyncEngine,
    render: StubRender,
    *,
    render_url: str | None = "http://render:8080",
) -> FastAPI:
    for name, value in RENDER_ENVS.items():
        monkeypatch.setenv(name, value)
    if render_url is None:
        monkeypatch.delenv("WHOLE_FILM_RENDER_URL", raising=False)
    else:
        monkeypatch.setenv("WHOLE_FILM_RENDER_URL", render_url)
    built = build_backed_app(
        config_with_media(),
        engine=engine,
        queue_connector=InMemoryConnector(),
        media_codec=SOFTWARE,
        whole_film_render_transport=render.transport(),
        credential_probe=KeyCheckingProbe({GOOD_KEY}),
    )
    await seed_agents(config_services_of(built), engine, CONVERSABLE_SEEDS)
    return built


__all__ = ["RENDER_ENVS", "build_whole_film_app"]
