from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from typing import Final

from cue.harness.step_store_pg import snapshots_table, store_snapshot_history
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncEngine

from iclip.platform.db.engine import build_engine

DEFAULT_BATCH_SIZE: Final = 200


def _database_url() -> str:
    url = os.environ.get("DATABASE_URL", "").strip()
    if not url:
        sys.exit("缺少环境变量 DATABASE_URL")
    return url


async def rewrite_inline_snapshots(
    engine: AsyncEngine, *, batch_size: int = DEFAULT_BATCH_SIZE
) -> int:
    if batch_size < 1:
        raise ValueError(f"batch_size must be >= 1, got {batch_size!r}")
    inline = ~snapshots_table.c.messages.startswith("{", autoescape=True)
    last_seq = 0
    rewritten = 0
    while True:
        async with engine.begin() as conn:
            rows = (
                await conn.execute(
                    select(snapshots_table.c.seq, snapshots_table.c.messages)
                    .where(inline, snapshots_table.c.seq > last_seq)
                    .order_by(snapshots_table.c.seq.asc())
                    .limit(batch_size)
                )
            ).all()
            if not rows:
                break
            for seq, messages_text in rows:
                refs_json = await store_snapshot_history(conn, json.loads(messages_text))
                await conn.execute(
                    update(snapshots_table)
                    .where(snapshots_table.c.seq == seq)
                    .values(messages=refs_json)
                )
                rewritten += 1
            last_seq = rows[-1].seq
        print(f"已改写 {rewritten} 行，处理到 seq {last_seq}")
    return rewritten


async def _main(batch_size: int) -> None:
    engine = build_engine(_database_url())
    try:
        total = await rewrite_inline_snapshots(engine, batch_size=batch_size)
    finally:
        await engine.dispose()
    print(f"完成：共改写 {total} 行")


def main() -> None:
    parser = argparse.ArgumentParser(description="把内联历史的快照行改成按消息引用存")
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    args = parser.parse_args()
    asyncio.run(_main(args.batch_size))


if __name__ == "__main__":
    main()
