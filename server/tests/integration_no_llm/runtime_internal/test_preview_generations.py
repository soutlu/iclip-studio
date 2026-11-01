"""测试预览里出的图不挂对话：经内部接口 ``/plugins/generations`` 提交时，预览 id 换成空，照常是属主的一条生成
记录；普通对话照旧挂着。所以治理者按预览 id 列不出记录，生成帧也不带预览 id；从这张宫格切出的图同样不挂。

装的是开着取帧与出图的后端（媒体生成、对象存储、``shot_video`` 段与本机 ffmpeg）；队列不跑，记录停在受理。"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import Generator
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from procrastinate.testing import InMemoryConnector
from pydantic_ai.models.test import TestModel
from sqlalchemy import text
from sqlalchemy.pool import NullPool
from starlette.testclient import TestClient

from iclip.config.models import ShotVideoSection
from iclip.domains.generation.infra_sql import SqlGenerationRepository
from iclip.domains.generation.models import GenerationJob
from iclip.domains.generation.service import SettledRecords
from iclip.domains.identity.public import Principal
from iclip.platform.db.engine import build_engine
from iclip.platform.media.codec import SOFTWARE
from iclip.platform.media.process import ffmpeg_available
from tests.helpers.agents import AgentSeed, model_builder, seed_agents
from tests.helpers.app import TEST_MODEL_NAME
from tests.helpers.generation import MEDIA_ENVS, MemoryObjectStore, config_with_media
from tests.helpers.model_providers import GOOD_KEY, KeyCheckingProbe
from tests.helpers.pg import connected, reset_database
from tests.helpers.runtime_backed import (
    RUNTIME_INTERNAL_TOKEN,
    build_backed_app,
    config_services_of,
)
from tests.helpers.ws import AGENT_ID, open_conversation, sign_in_as

pytestmark = pytest.mark.skipif(not ffmpeg_available(), reason="本机 PATH 上没有 ffmpeg/ffprobe")

AUTHORIZED = {"Authorization": f"Bearer {RUNTIME_INTERNAL_TOKEN}"}


@pytest.fixture
def shot_app(
    base_env: None, migrated_pg: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> Generator[FastAPI]:
    for name, value in MEDIA_ENVS.items():
        monkeypatch.setenv(name, value)
    asyncio.run(_reset(migrated_pg))
    engine = build_engine(migrated_pg, poolclass=NullPool)
    config = config_with_media().model_copy(update={"shot_video": ShotVideoSection()})
    built = build_backed_app(
        config,
        engine=engine,
        object_store=MemoryObjectStore(),
        queue_connector=InMemoryConnector(),
        media_codec=SOFTWARE,
        skill_cache_dir=tmp_path / "skills",
        build_model=model_builder({TEST_MODEL_NAME: TestModel()}),
        credential_probe=KeyCheckingProbe({GOOD_KEY}),
    )
    asyncio.run(seed_agents(config_services_of(built), engine, (AgentSeed(AGENT_ID),)))
    yield built
    asyncio.run(engine.dispose())


async def _reset(url: str) -> None:
    async with connected(url) as conn:
        await reset_database(conn)


async def _grant(url: str, username: str, permissions: list[str]) -> None:
    async with connected(url) as conn:
        await conn.execute(
            text(
                "UPDATE iclip.users SET direct_permissions = CAST(:p AS jsonb) WHERE username = :u"
            ),
            {"p": json.dumps(permissions), "u": username},
        )


async def _conversation_of(url: str, job_id: str) -> uuid.UUID | None:
    async with connected(url) as conn:
        found: uuid.UUID | None = (
            await conn.execute(
                text("SELECT conversation_id FROM iclip.generation_jobs WHERE id = :id"),
                {"id": job_id},
            )
        ).scalar_one()
    return found


async def _complete(url: str, job_id: str) -> None:
    async with connected(url) as conn:
        await conn.execute(
            text(
                "UPDATE iclip.generation_jobs SET status = 'completed',"
                """ output = '{"url": "https://cdn.example.test/grid.png"}'::jsonb"""
                " WHERE id = :id"
            ),
            {"id": job_id},
        )


async def _cut(url: str, principal: Principal, grid_id: str) -> tuple[GenerationJob, ...]:
    """照切格接口落切图记录的那一步（``SettledRecords.record_cuts``），从这张宫格切一格。"""

    engine = build_engine(url, poolclass=NullPool)
    try:
        records = SettledRecords(SqlGenerationRepository(engine))
        return await records.record_cuts(
            principal, uuid.UUID(grid_id), ["https://cdn.example.test/cut-1.png"]
        )
    finally:
        await engine.dispose()


def _submit(tc: TestClient, owner_id: str, conversation_id: str) -> str:
    submitted = tc.post(
        "/internal/runtime/plugins/generations",
        json={
            "user_id": owner_id,
            "request": {
                "prompt": "雨中中景",
                "model": "nano_banana_pro",
                "aspect_ratio": "9:16",
                "resolution": "4k",
                "channel": "dev",
                "user_name": "owner",
                "conversation_id": conversation_id,
            },
        },
        headers=AUTHORIZED,
    )
    assert submitted.status_code == 200, submitted.text
    return str(submitted.json()["job_id"])


def _generation_frames_until(ws: Any, session_id: str, *, tries: int = 40) -> list[dict[str, Any]]:
    """收 ``event.generation.changed``，直到收到一帧挂着 ``session_id`` 的。"""

    frames: list[dict[str, Any]] = []
    for _ in range(tries):
        frame: dict[str, Any] = ws.receive_json()
        if frame.get("type") != "event.generation.changed":
            continue
        frames.append(frame)
        if frame.get("session_id") == session_id:
            return frames
    raise AssertionError(f"没收到挂着 {session_id} 的生成帧")


def test_images_from_a_preview_are_recorded_without_a_conversation(
    shot_app: FastAPI, migrated_pg: str
) -> None:
    with TestClient(shot_app) as tc:
        owner = sign_in_as(tc, migrated_pg, username="owner", roles=("editor",))
        governor = sign_in_as(tc, migrated_pg, username="governor", roles=("editor",))
        asyncio.run(_grant(migrated_pg, "owner", ["agent:manage"]))
        asyncio.run(_grant(migrated_pg, "governor", ["users:manage"]))
        owner_id = tc.get("/users/me", headers=owner).json()["user"]["id"]
        opened = tc.post(f"/agents/{AGENT_ID}/previews", headers=owner)
        assert opened.status_code == 201, opened.text
        preview = str(opened.json()["id"])
        conversation = open_conversation(tc, headers=owner)

        with tc.websocket_connect("/ws", headers=governor) as ws:
            assert ws.receive_json()["type"] == "server_hello"
            from_preview = _submit(tc, owner_id, preview)
            from_conversation = _submit(tc, owner_id, conversation)
            frames = _generation_frames_until(ws, conversation)

        by_preview = tc.get("/generations", params={"conversationId": preview}, headers=governor)
        by_conversation = tc.get(
            "/generations", params={"conversationId": conversation}, headers=governor
        )

        # 预览出的宫格完成后切图：切出来的沿用宫格的对话，也不挂。
        asyncio.run(_complete(migrated_pg, from_preview))
        principal = Principal(
            kind="user",
            user_id=uuid.UUID(owner_id),
            permissions=frozenset({"agent:run"}),
            audit_label="owner",
        )
        cuts = asyncio.run(_cut(migrated_pg, principal, from_preview))

    # 治理者那边：预览出的那张发了帧，但不带预览 id；按预览 id 列不出东西。
    assert any(frame["payload"]["id"] == from_preview for frame in frames)
    assert [frame.get("session_id") for frame in frames if frame.get("session_id")] == [
        conversation
    ]
    assert by_preview.status_code == 200, by_preview.text
    assert by_preview.json()["items"] == []
    assert [item["id"] for item in by_conversation.json()["items"]] == [from_conversation]
    # 落库：预览的那张与从它切出的都不挂对话，普通对话的照旧挂着。
    assert [cut.conversation_id for cut in cuts] == [None]
    assert asyncio.run(_conversation_of(migrated_pg, from_preview)) is None
    assert asyncio.run(_conversation_of(migrated_pg, from_conversation)) == uuid.UUID(conversation)
