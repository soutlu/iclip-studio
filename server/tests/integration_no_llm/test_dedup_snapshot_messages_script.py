from __future__ import annotations

from cue.harness.step_store_pg import PgStepStore
from pydantic_ai.messages import (
    BinaryContent,
    ModelMessage,
    ModelMessagesTypeAdapter,
    ModelRequest,
    ModelResponse,
    TextPart,
    UserPromptPart,
)
from pydantic_ai_harness.step_persistence import ContinuableSnapshot
from scripts.dedup_snapshot_messages import rewrite_inline_snapshots
from sqlalchemy.ext.asyncio import AsyncEngine

from tests.helpers.pg import insert_inline_snapshot, raw_snapshot_messages, stored_message_count


def _messages(content: str) -> list[ModelMessage]:
    return [
        ModelRequest(parts=[UserPromptPart(content=content)]),
        ModelResponse(parts=[TextPart(content=f"re: {content}")]),
    ]


def _dump(messages: list[ModelMessage]) -> bytes:
    return ModelMessagesTypeAdapter.dump_json(messages)


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
    blob = bytes(range(256)) * 512
    first = [
        ModelRequest(
            parts=[
                UserPromptPart(content=["看图", BinaryContent(data=blob, media_type="image/png")])
            ]
        ),
        ModelResponse(parts=[TextPart(content="看到了")]),
    ]
    longer = [*first, *_messages("second")]
    await insert_inline_snapshot(
        engine, run_id="r1", step_index=1, conversation_id="conv-r1", messages=first
    )
    await insert_inline_snapshot(
        engine, run_id="r1", step_index=2, conversation_id="conv-r1", messages=longer
    )
    await insert_inline_snapshot(
        engine, run_id="r2", step_index=1, conversation_id="conv-r2", messages=_messages("other")
    )
    await store.save_snapshot(
        ContinuableSnapshot(
            run_id="r2",
            step_index=2,
            conversation_id="conv-r2",
            messages=_messages("already referenced"),
            state="complete",
        )
    )
    referenced_row = (await raw_snapshot_messages(engine))[3]
    before = await _reads(store)

    assert await rewrite_inline_snapshots(engine, batch_size=2) == 3

    raw = await raw_snapshot_messages(engine)
    assert all(row.startswith('{"message_refs": ') for row in raw)
    assert raw[3] == referenced_row
    assert await _reads(store) == before
    assert await stored_message_count(engine) == 8

    assert await rewrite_inline_snapshots(engine, batch_size=2) == 0
    assert await raw_snapshot_messages(engine) == raw

    await store.save_snapshot(
        ContinuableSnapshot(run_id="r3", step_index=1, messages=longer, state="complete")
    )
    assert await stored_message_count(engine) == 8
    assert (await raw_snapshot_messages(engine))[-1] == raw[1]
