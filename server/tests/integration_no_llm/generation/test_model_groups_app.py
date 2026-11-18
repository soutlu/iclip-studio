from __future__ import annotations

import json
import uuid
from collections.abc import AsyncGenerator

import pytest
from fastapi import FastAPI
from procrastinate.testing import InMemoryConnector
from sqlalchemy import text

from iclip.app.bootstrap import build_app
from iclip.config import ModelGroupSection
from iclip.platform.db.engine import build_engine
from iclip.platform.media.codec import SOFTWARE
from tests.helpers.app import make_client
from tests.helpers.auth import login_as_editor
from tests.helpers.generation import MEDIA_ENVS, MemoryObjectStore, config_with_media
from tests.helpers.pg import connected, reset_database

VIDEO_BODY = {"model": "seedance", "prompt": "一只猫跳上窗台", "aspect_ratio": "16:9", "seconds": 5}


@pytest.fixture
async def grouped_app(
    base_env: None, migrated_pg: str, monkeypatch: pytest.MonkeyPatch
) -> AsyncGenerator[FastAPI]:
    for name, value in MEDIA_ENVS.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setenv("VIDEO_API_KEY_MKT", "vk-mkt")
    async with connected(migrated_pg) as conn:
        await reset_database(conn)
    config = config_with_media().model_copy(
        update={
            "model_groups": {
                "mkt": ModelGroupSection(
                    departments=(101,),
                    video_api_key_env="VIDEO_API_KEY_MKT",
                    video_models={"seedance": "mkt-seedance"},
                )
            }
        }
    )
    engine = build_engine(migrated_pg)
    try:
        yield build_app(
            config,
            engine=engine,
            object_store=MemoryObjectStore(),
            queue_connector=InMemoryConnector(),
            media_codec=SOFTWARE,
        )
    finally:
        await engine.dispose()


async def _set_departments(pg_url: str, user_id: str, departments: list[int]) -> None:
    async with connected(pg_url) as conn:
        await conn.execute(
            text("UPDATE iclip.users SET departments = CAST(:departments AS jsonb) WHERE id = :id"),
            {"departments": json.dumps([{"id": d} for d in departments]), "id": user_id},
        )


async def _recorded_group(pg_url: str, job_id: str) -> tuple[str | None, str | None]:
    async with connected(pg_url) as conn:
        row = (
            await conn.execute(
                text(
                    "SELECT model_group, upstream_model FROM iclip.generation_jobs WHERE id = :id"
                ),
                {"id": uuid.UUID(job_id)},
            )
        ).one()
    return row.model_group, row.upstream_model


@pytest.mark.parametrize(
    ("departments", "expected"),
    [([101], ("mkt", "mkt-seedance")), ([], (None, None))],
    ids=["in_mkt", "no_department"],
)
async def test_the_assembled_app_records_the_group_of_the_users_synced_departments(
    grouped_app: FastAPI,
    pg_url: str,
    departments: list[int],
    expected: tuple[str | None, str | None],
) -> None:
    async with make_client(grouped_app) as client:
        user_id = await login_as_editor(client, pg_url, username="logan")
        await _set_departments(pg_url, user_id, departments)

        response = await client.post(
            "/generations/video", json={**VIDEO_BODY, "user_name": "logan"}
        )

    assert response.status_code == 202, response.text
    assert await _recorded_group(pg_url, response.json()["task_id"]) == expected
