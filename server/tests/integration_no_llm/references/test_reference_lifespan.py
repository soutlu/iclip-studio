"""参考视频的 worker 与对话运行在同一个 lifespan 里起停；媒体生成没开时，排进去的拆解照样被执行完。

直接驱动 lifespan_context，与 uvicorn 保持一致；队列连接真实测试数据库，拆解与打标是替身。"""

from __future__ import annotations

import asyncio

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from iclip.app.bootstrap import build_app
from iclip.platform.media.codec import SOFTWARE
from tests.helpers.app import make_client
from tests.helpers.auth import login_as_editor
from tests.helpers.generation import MemoryObjectStore
from tests.helpers.pg import connected, reset_database, truncate_clean
from tests.helpers.references import (
    DOCUMENT,
    STUDIO_ENVS,
    FakeArk,
    ark_pipeline,
    config_with_studio,
    upload_video,
)


async def _workers(pg_url: str) -> int:
    async with connected(pg_url) as conn:
        return int(
            (await conn.execute(text("SELECT count(*) FROM procrastinate_workers"))).scalar_one()
        )


async def test_breakdowns_run_in_the_app_lifespan_without_media_generation(
    base_env: None, migrated_pg: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    for name, value in STUDIO_ENVS.items():
        monkeypatch.setenv(name, value)
    monkeypatch.delenv("VIDEO_SUBMIT_URL", raising=False)
    async with connected(migrated_pg) as conn:
        await reset_database(conn)
        await truncate_clean(conn, ("procrastinate_jobs", "procrastinate_workers"), cascade=True)
    bucket = MemoryObjectStore()
    ark = FakeArk()
    breakdowns, tagger = ark_pipeline(ark)
    engine = create_async_engine(migrated_pg)
    app = build_app(
        config_with_studio(),
        engine=engine,
        object_store=bucket,
        reference_breakdowns=breakdowns,
        reference_tagger=tagger,
        media_codec=SOFTWARE,
    )

    lifespan = app.router.lifespan_context(app)
    await lifespan.__aenter__()
    try:
        async with make_client(app) as http:
            await login_as_editor(http, migrated_pg)
            upload_id = await upload_video(http, bucket)
            created = (await http.post("/references", json={"uploadId": upload_id})).json()
            detail = created
            for _ in range(200):
                detail = (await http.get(f"/references/{created['id']}")).json()
                if detail["breakdownStatus"] == "completed":
                    break
                await asyncio.sleep(0.05)
        assert await _workers(migrated_pg) == 1, "lifespan 里起着参考视频的 worker"
    finally:
        await lifespan.__aexit__(None, None, None)
        await engine.dispose()

    assert detail["breakdownStatus"] == "completed", detail
    assert detail["document"] == DOCUMENT
    assert (detail["videoTypes"], detail["categories"]) == (["review"], ["跑鞋"])
    assert ark.breakdown_calls == 1
    assert await _workers(migrated_pg) == 0, "lifespan 结束时 worker 跟着停了"
