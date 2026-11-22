from __future__ import annotations

import pytest
from fastapi import FastAPI
from procrastinate.testing import InMemoryConnector
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.config import FinalCutSection
from iclip.platform.media.codec import SOFTWARE
from tests.helpers.agents import CONVERSABLE_SEEDS, seed_agents
from tests.helpers.app import TEST_OBJECT_STORE
from tests.helpers.generation import MEDIA_ENVS, config_with_media
from tests.helpers.model_providers import GOOD_KEY, KeyCheckingProbe
from tests.helpers.render import StubRender
from tests.helpers.runtime_backed import build_backed_app, config_services_of


async def build_whole_film_app(
    monkeypatch: pytest.MonkeyPatch,
    engine: AsyncEngine,
    render: StubRender,
    *,
    render_url: str | None = "http://render:8080",
) -> FastAPI:
    for name, value in MEDIA_ENVS.items():
        monkeypatch.setenv(name, value)
    config = config_with_media().model_copy(
        update={
            "object_store": TEST_OBJECT_STORE.model_copy(
                update={"internal_endpoint": "https://oss-ap-southeast-1-internal.aliyuncs.com"}
            ),
            "final_cut": FinalCutSection(render_url=render_url),
        }
    )
    built = build_backed_app(
        config,
        engine=engine,
        queue_connector=InMemoryConnector(),
        media_codec=SOFTWARE,
        final_cut_render_transport=render.transport(),
        credential_probe=KeyCheckingProbe({GOOD_KEY}),
    )
    await seed_agents(config_services_of(built), engine, CONVERSABLE_SEEDS)
    return built


__all__ = ["build_whole_film_app"]
