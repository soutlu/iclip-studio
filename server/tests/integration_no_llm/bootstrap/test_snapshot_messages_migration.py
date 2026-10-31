"""快照消息表迁移：升级建出与 ``step_store_pg`` 一致的表与索引。"""

from __future__ import annotations

import asyncio
from typing import Any

from agent_runtime.harness.step_store_pg import DB_SCHEMA, snapshot_messages_table, snapshots_table
from alembic import command
from sqlalchemy import inspect
from sqlalchemy.pool import NullPool

from iclip.platform.db.engine import build_engine
from tests.helpers.migrations import alembic_config

BEFORE = "a6e8d20c4f91"
AFTER = "ad8ae2f51ce1"


async def _schema(url: str) -> dict[str, Any]:
    engine = build_engine(url, poolclass=NullPool)
    try:
        async with engine.connect() as conn:
            return await conn.run_sync(
                lambda sync_conn: _inspect(inspect(sync_conn)),
            )
    finally:
        await engine.dispose()


def _inspect(inspector: Any) -> dict[str, Any]:
    tables = set(inspector.get_table_names(schema=DB_SCHEMA))
    messages = None
    if "snapshot_messages" in tables:
        messages = {
            "columns": {
                column["name"]: (str(column["type"]), column["nullable"])
                for column in inspector.get_columns("snapshot_messages", schema=DB_SCHEMA)
            },
            "pk": inspector.get_pk_constraint("snapshot_messages", schema=DB_SCHEMA)[
                "constrained_columns"
            ],
        }
    indexes = {
        index["name"]: index["column_names"]
        for index in inspector.get_indexes("snapshots", schema=DB_SCHEMA)
    }
    return {"snapshot_messages": messages, "snapshot_indexes": indexes}


def test_upgrade_creates_table_and_index_matching_store(
    scratch_db: str,
) -> None:
    cfg = alembic_config(scratch_db)
    command.upgrade(cfg, BEFORE)
    before = asyncio.run(_schema(scratch_db))
    assert before["snapshot_messages"] is None
    assert "idx_snapshots_conv" not in before["snapshot_indexes"]

    command.upgrade(cfg, AFTER)

    after = asyncio.run(_schema(scratch_db))
    assert after["snapshot_messages"] == {
        "columns": {
            column.name: ("TEXT", column.nullable) for column in snapshot_messages_table.columns
        },
        "pk": ["sha256"],
    }
    assert after["snapshot_indexes"] == {
        index.name: [column.name for column in index.columns] for index in snapshots_table.indexes
    }
