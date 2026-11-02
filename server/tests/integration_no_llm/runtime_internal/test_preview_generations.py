"""测试预览里出的图不挂对话：工具按运行依赖构造不带对话的请求，预览被换掉后才到达内部接口也保持隔离。
普通对话照旧挂着，所以治理者按预览 id 列不出记录，生成帧也不带预览 id；从这张宫格切出的图同样不挂。

装的是开着取帧与出图的后端（媒体生成、对象存储、``shot_video`` 段与本机 ffmpeg）；队列不跑，记录停在受理。"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import Generator
from pathlib import Path
from typing import Any

import httpx
import pytest
from agent_runtime.file_store.store import FileSpace
from agent_runtime.plugins.workspace.scope import workspace_namespace
from agent_runtime.run_deps import AgentRunDeps
from fastapi import FastAPI
from iclip_video.shot_video.capability import GenerationPolicy
from iclip_video.shot_video.ports import ImageRequest
from iclip_video.shot_video.toolset import ShotVideoToolset
from iclip_video.shot_video.wire import ImageSubmission
from procrastinate.testing import InMemoryConnector
from pydantic_ai import ToolFailed
from pydantic_ai.models.test import TestModel
from pydantic_ai.tools import RunContext
from pydantic_ai.usage import RunUsage
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
from tests.helpers.fetch_url import as_is
from tests.helpers.file_store import FakeFileStore
from tests.helpers.generation import MEDIA_ENVS, MemoryObjectStore, config_with_media
from tests.helpers.material_ledger import FakeMaterialLedger
from tests.helpers.model_providers import GOOD_KEY, KeyCheckingProbe
from tests.helpers.pg import connected, reset_database
from tests.helpers.runtime_backed import (
    RUNTIME_INTERNAL_TOKEN,
    build_backed_app,
    config_services_of,
)
from tests.helpers.shot_video import (
    FakeCutRecords,
    FakeGenerations,
    FakeObjects,
    Outcome,
    mount_shot_video,
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


async def _tool_request(owner_id: str, session_id: str, *, preview: bool) -> ImageRequest:
    """取真实工具已交给生成端口的请求，模拟传输晚于预览关闭才送达后端。"""

    generations = FakeGenerations(outcomes=[Outcome(status="failed")])
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _: httpx.Response(404))
    ) as client:
        capability = mount_shot_video(
            space=FileSpace(store=FakeFileStore(), namespace=workspace_namespace),
            ledger=FakeMaterialLedger(),
            generations=generations,
            objects=FakeObjects(),
            records=FakeCutRecords(),
            client=client,
            fetch_url=as_is,
            policy=GenerationPolicy(
                poll_interval_seconds=0,
                dev_attempts=1,
                pro_attempts=0,
                backoff_seconds=0,
                backoff_factor=1,
                total_timeout_seconds=10,
            ),
            codec=SOFTWARE,
        )
        tools = capability.get_toolset()
        assert isinstance(tools, ShotVideoToolset)
        context = RunContext[object](
            deps=AgentRunDeps(
                user_id=uuid.UUID(owner_id),
                conversation_id=session_id,
                user_name="owner",
                preview=preview,
            ),
            model=TestModel(),
            usage=RunUsage(),
        )
        # 本例只执行到出站请求，媒体完成与裁图另由后端记录验证。
        with pytest.raises(ToolFailed):
            await tools.generate_anchor_sheet(context, ["雨中中景"])
    (request,) = generations.submitted
    return request


def _submit(tc: TestClient, owner_id: str, request: ImageRequest) -> str:
    submitted = tc.post(
        "/internal/runtime/plugins/generations",
        json=ImageSubmission(user_id=uuid.UUID(owner_id), request=request).model_dump(mode="json"),
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


def test_images_arriving_after_the_preview_is_replaced_are_recorded_without_a_conversation(
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

        preview_request = asyncio.run(_tool_request(owner_id, preview, preview=True))
        conversation_request = asyncio.run(_tool_request(owner_id, conversation, preview=False))
        replaced = tc.post(f"/agents/{AGENT_ID}/previews", headers=owner)
        assert replaced.status_code == 201, replaced.text
        assert tc.get(f"/conversations/{preview}/status", headers=owner).status_code == 404

        with tc.websocket_connect("/ws", headers=governor) as ws:
            assert ws.receive_json()["type"] == "server_hello"
            from_preview = _submit(tc, owner_id, preview_request)
            from_conversation = _submit(tc, owner_id, conversation_request)
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
