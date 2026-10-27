"""一次性改写脚本：内联历史的快照行改成按消息引用存，可重复运行，读出来不变。"""

from __future__ import annotations

import json
from datetime import UTC, datetime

from pydantic_ai.messages import (
    BinaryContent,
    ModelMessage,
    ModelMessagesTypeAdapter,
    ModelRequest,
    ModelResponse,
    TextPart,
    UserPromptPart,
)
from pydantic_ai_harness.media import externalize_media
from pydantic_ai_harness.step_persistence import ContinuableSnapshot
from scripts.dedup_snapshot_messages import rewrite_inline_snapshots
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.harness.step_store_pg import PgMediaStore, PgStepStore, snapshots_table

T0 = datetime(2026, 10, 27, 10, 0, 0, tzinfo=UTC)
_THRESHOLD = 64 * 1024


def _messages(content: str) -> list[ModelMessage]:
    return [
        ModelRequest(parts=[UserPromptPart(content=content)]),
        ModelResponse(parts=[TextPart(content=f"re: {content}")]),
    ]


def _dump(messages: list[ModelMessage]) -> bytes:
    return ModelMessagesTypeAdapter.dump_json(messages)


async def _insert_inline(
    engine: AsyncEngine, *, run_id: str, step_index: int, messages: list[ModelMessage]
) -> None:
    """按改为引用存之前 ``save_snapshot`` 的写法落一行：外置媒体后整段历史内联。"""

    messages_json = await externalize_media(
        json.loads(_dump(messages)),
        media_store=PgMediaStore(engine),
        threshold_bytes=_THRESHOLD,
    )
    async with engine.begin() as conn:
        await conn.execute(
            snapshots_table.insert().values(
                run_id=run_id,
                step_index=step_index,
                conversation_id=f"conv-{run_id}",
                timestamp=T0,
                state="complete",
                messages=json.dumps(messages_json),
            )
        )


async def _raw_messages(engine: AsyncEngine) -> list[str]:
    async with engine.connect() as conn:
        rows = await conn.execute(text("SELECT messages FROM agent_runtime.snapshots ORDER BY seq"))
        return [row[0] for row in rows]


async def _stored_message_count(engine: AsyncEngine) -> int:
    async with engine.connect() as conn:
        return (
            await conn.execute(text("SELECT count(*) FROM agent_runtime.snapshot_messages"))
        ).scalar_one()


async def _reads(store: PgStepStore) -> list[tuple[str, int, bytes]]:
    snapshots = [
        snapshot
        for run_id in ("r1", "r2")
        for snapshot in await store.list_snapshots(run_id=run_id)
    ]
    latest = await store.latest_conversation_snapshot(conversation_id="conv-r1")
    assert latest is not None
    return [(s.run_id, s.step_index, _dump(s.messages)) for s in [*snapshots, latest]]


async def test_rewrite_converts_inline_rows_idempotently(engine: AsyncEngine) -> None:
    store = PgStepStore(engine)
    blob = bytes(range(256)) * 512  # 128 KiB，超过外置阈值
    first = [
        ModelRequest(
            parts=[
                UserPromptPart(content=["看图", BinaryContent(data=blob, media_type="image/png")])
            ]
        ),
        ModelResponse(parts=[TextPart(content="看到了")]),
    ]
    longer = [*first, *_messages("second")]
    await _insert_inline(engine, run_id="r1", step_index=1, messages=first)
    await _insert_inline(engine, run_id="r1", step_index=2, messages=longer)
    await _insert_inline(engine, run_id="r2", step_index=1, messages=_messages("other"))
    await store.save_snapshot(
        ContinuableSnapshot(
            run_id="r2",
            step_index=2,
            conversation_id="conv-r2",
            messages=_messages("already referenced"),
            state="complete",
        )
    )
    referenced_row = (await _raw_messages(engine))[3]
    before = await _reads(store)

    assert await rewrite_inline_snapshots(engine, batch_size=2) == 3

    raw = await _raw_messages(engine)
    assert all(row.startswith('{"message_refs": ') for row in raw)
    assert raw[3] == referenced_row
    assert await _reads(store) == before
    assert await _stored_message_count(engine) == 8

    assert await rewrite_inline_snapshots(engine, batch_size=2) == 0
    assert await _raw_messages(engine) == raw

    # 改写存下的消息与 save_snapshot 存的逐字节一致：同样的历史再保存一次，不新增消息。
    await store.save_snapshot(
        ContinuableSnapshot(run_id="r3", step_index=1, messages=longer, state="complete")
    )
    assert await _stored_message_count(engine) == 8
    assert (await _raw_messages(engine))[-1] == raw[1]
