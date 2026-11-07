from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator
from typing import Any

from agent_runtime.harness.background import BackgroundTools
from agent_runtime.harness.transcript.store import TranscriptStore
from pydantic_ai import Tool
from pydantic_ai.messages import ModelMessage
from pydantic_ai.models.function import (
    AgentInfo,
    DeltaToolCall,
    DeltaToolCalls,
    FunctionModel,
)
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from iclip.domains.references.infra_sql import SqlReferenceStore
from tests.helpers.pg import connected
from tests.helpers.runtime import build_runner, submit_text


def _breaks_down_then_ends(ended: asyncio.Event) -> FunctionModel:
    async def stream(
        messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        if len(messages) == 1:
            yield {0: DeltaToolCall(name="breakdown_video", json_args="{}", tool_call_id="call_bd")}
        else:
            ended.set()
            yield "等拆解。"

    return FunctionModel(stream_function=stream)


def _polling_breakdown(engine: AsyncEngine) -> Tool[Any]:
    store = SqlReferenceStore(engine)
    reference_id = uuid.uuid4()

    async def breakdown_video() -> str:
        while await store.get(reference_id) is None:
            await asyncio.sleep(0.01)
        return "拆完了"

    return Tool(breakdown_video, name="breakdown_video", metadata={"background": True})


async def _until_a_query_waits_on_the_lock(lock: AsyncConnection) -> None:
    for _ in range(500):
        await lock.execute(text("select pg_stat_clear_snapshot()"))
        waiting = (
            await lock.execute(
                text(
                    "select count(*) from pg_stat_activity where wait_event_type = 'Lock'"
                    " and query ilike '%reference_videos%' and pid <> pg_backend_pid()"
                )
            )
        ).scalar_one()
        if waiting:
            return
        await asyncio.sleep(0.01)
    raise AssertionError("拆解的查询没有卡在锁上")


async def _settled_status(lock: AsyncConnection, prompt_id: str) -> str:
    status = ""
    for _ in range(250):
        status = (
            await lock.execute(
                text("select status from agent_runtime.agent_jobs where prompt_id = :prompt_id"),
                {"prompt_id": prompt_id},
            )
        ).scalar_one()
        if status not in ("queued", "running"):
            break
        await asyncio.sleep(0.02)
    return status


async def test_stopping_while_a_background_tool_waits_on_the_database_aborts_the_prompt(
    engine: AsyncEngine, migrated_pg: str
) -> None:
    ended = asyncio.Event()
    runner, _step_store, queue = build_runner(
        engine,
        _breaks_down_then_ends(ended),
        store=TranscriptStore(),
        tools=[_polling_breakdown(engine)],
        capabilities=[BackgroundTools()],
        context_limits={},
    )
    conversation_id = f"c-{uuid.uuid4().hex[:8]}"
    try:
        async with connected(migrated_pg) as lock:
            await lock.execute(text("lock table iclip.reference_videos in access exclusive mode"))
            prompt_id = await submit_text(runner, queue, conversation_id, "拆一下这条视频")
            await _until_a_query_waits_on_the_lock(lock)
            await ended.wait()
            await runner.abort(conversation_id, prompt_id)
            status = await _settled_status(lock, prompt_id)
    finally:
        await runner.shutdown()

    assert status == "aborted"
    for _ in range(5):
        async with engine.connect() as conn:
            assert (await conn.execute(text("select 1"))).scalar_one() == 1
