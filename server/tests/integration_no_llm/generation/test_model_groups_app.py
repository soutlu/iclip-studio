from __future__ import annotations

import uuid

import pytest
from fastapi import FastAPI
from procrastinate.testing import InMemoryConnector
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.app.bootstrap import build_app
from iclip.config import ModelGroupSection
from iclip.platform.media.codec import SOFTWARE
from tests.helpers.app import make_client
from tests.helpers.auth import login_as_editor, register_and_login, set_roles_in_db
from tests.helpers.generation import MEDIA_ENVS, MemoryObjectStore, config_with_media
from tests.helpers.model_groups import MKT, set_model_group_in_db
from tests.helpers.pg import connected

VIDEO_BODY = {"model": "seedance", "prompt": "一只猫跳上窗台", "aspect_ratio": "16:9", "seconds": 5}


@pytest.fixture
def grouped_app(base_env: None, engine: AsyncEngine, monkeypatch: pytest.MonkeyPatch) -> FastAPI:
    for name, value in MEDIA_ENVS.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setenv("VIDEO_API_KEY_MKT", "vk-mkt")
    config = config_with_media().model_copy(
        update={
            "model_groups": {
                MKT: ModelGroupSection(
                    video_api_key_env="VIDEO_API_KEY_MKT", video_models={"seedance": "mkt-seedance"}
                )
            }
        }
    )
    return build_app(
        config,
        engine=engine,
        object_store=MemoryObjectStore(),
        queue_connector=InMemoryConnector(),
        media_codec=SOFTWARE,
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
    ("group", "expected"),
    [(MKT, (MKT, "mkt-seedance")), (None, (None, None))],
    ids=["in_mkt", "default_group"],
)
async def test_a_group_root_picks_applies_to_the_users_next_video_without_a_restart(
    grouped_app: FastAPI,
    pg_url: str,
    group: str | None,
    expected: tuple[str | None, str | None],
) -> None:
    async with make_client(grouped_app) as root, make_client(grouped_app) as user:
        await register_and_login(root, username="root", email="root@example.com")
        await set_roles_in_db(pg_url, "root@example.com", ["root"])
        user_id = await login_as_editor(user, pg_url, username="logan")

        picked = await root.put(f"/users/{user_id}/model-group", json={"modelGroup": group})
        assert picked.status_code == 200, picked.text
        assert picked.json()["user"]["modelGroup"] == group

        response = await user.post("/generations/video", json={**VIDEO_BODY, "user_name": "logan"})

    assert response.status_code == 202, response.text
    assert await _recorded_group(pg_url, response.json()["task_id"]) == expected


async def test_a_user_whose_group_left_the_config_cannot_make_videos(
    grouped_app: FastAPI, pg_url: str
) -> None:
    async with make_client(grouped_app) as client:
        user_id = await login_as_editor(client, pg_url, username="logan")
        await set_model_group_in_db(pg_url, user_id, "retired")

        response = await client.post(
            "/generations/video", json={**VIDEO_BODY, "user_name": "logan"}
        )

    assert response.status_code == 409, response.text
    assert response.json()["code"] == "model_group_unavailable"
    assert "retired" in response.json()["detail"]
    async with connected(pg_url) as conn:
        jobs = (await conn.execute(text("SELECT count(*) FROM iclip.generation_jobs"))).scalar()
    assert jobs == 0, "不悄悄按默认组受理"
