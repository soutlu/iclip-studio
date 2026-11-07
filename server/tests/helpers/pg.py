from __future__ import annotations

import json
import warnings
from collections.abc import AsyncGenerator, Sequence
from contextlib import asynccontextmanager
from datetime import UTC, datetime

from cue.harness.step_store_pg import PgMediaStore, snapshots_table
from pydantic_ai.messages import ModelMessage, ModelMessagesTypeAdapter
from pydantic_ai_harness.media import externalize_media
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine
from sqlalchemy.pool import NullPool

from iclip.platform.db.engine import build_engine

APP_TABLES = (
    "iclip.users",
    "iclip.oauth_accounts",
    "iclip.api_keys",
    "iclip.conversations",
    "iclip.whole_film_drafts",
    "iclip.agent_previews",
    "iclip.collections",
    "iclip.tasks",
    "iclip.task_assignees",
    "iclip.generation_jobs",
    "iclip.tracking_events",
    "iclip.inspiration_videos",
    "iclip.reference_videos",
    "iclip.library_entries",
    "iclip.library_entry_tags",
    "iclip.brand_templates",
    "iclip.brand_profiles",
)

AGENT_RUNTIME_TABLES = (
    "agent_runtime.runs",
    "agent_runtime.events",
    "agent_runtime.snapshots",
    "agent_runtime.snapshot_messages",
    "agent_runtime.snapshot_idempotency_keys",
    "agent_runtime.tool_effects",
    "agent_runtime.media",
    "agent_runtime.agent_jobs",
    "agent_runtime.agent_job_runs",
    "agent_runtime.conversation_usage",
    "agent_runtime.workspace_files",
    "agent_runtime.sessions",
    "agent_runtime.skills",
    "agent_runtime.skill_draft_files",
    "agent_runtime.skill_versions",
    "agent_runtime.skill_version_files",
    "agent_runtime.model_providers",
    "agent_runtime.provider_credentials",
    "agent_runtime.provider_models",
    "agent_runtime.default_models",
    "agent_runtime.mcp_servers",
    "agent_runtime.agents",
    "agent_runtime.agent_drafts",
    "agent_runtime.agent_versions",
    "agent_runtime.agent_revisions",
    "agent_runtime.agent_skill_bindings",
    "agent_runtime.agent_version_skills",
)

LOCK_TIMEOUT = "10s"


async def truncate_clean(
    conn: AsyncConnection, tables: Sequence[str], *, cascade: bool = False
) -> None:
    holders = (
        await conn.execute(
            text(
                "SELECT DISTINCT l.pid, a.state, left(a.query, 160) AS query "
                "FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid "
                "WHERE l.locktype = 'relation' AND l.pid <> pg_backend_pid() "
                "AND l.relation = ANY(CAST(:tables AS text[])::regclass[])"
            ),
            {"tables": list(tables)},
        )
    ).all()
    for pid, state, query in holders:
        await conn.execute(text("SELECT pg_terminate_backend(:pid)"), {"pid": pid})
        warnings.warn(
            f"上一个用例遗留的数据库会话（pid={pid}，state={state!r}）还握着表锁，已踢掉；"
            f"它当时在跑：{query}",
            stacklevel=2,
        )
    await conn.execute(text(f"SET LOCAL lock_timeout = '{LOCK_TIMEOUT}'"))
    await conn.execute(text(f"TRUNCATE {', '.join(tables)}{' CASCADE' if cascade else ''}"))


async def reset_database(conn: AsyncConnection) -> None:
    await truncate_clean(conn, (*APP_TABLES, *AGENT_RUNTIME_TABLES))


@asynccontextmanager
async def connected(url: str) -> AsyncGenerator[AsyncConnection]:
    engine = build_engine(url, poolclass=NullPool)
    try:
        async with engine.begin() as conn:
            yield conn
    finally:
        await engine.dispose()


_INLINE_SNAPSHOT_AT = datetime(2026, 10, 27, 10, 0, 0, tzinfo=UTC)
_MEDIA_THRESHOLD_BYTES = 64 * 1024


async def insert_inline_snapshot(
    engine: AsyncEngine,
    *,
    run_id: str,
    step_index: int,
    conversation_id: str,
    messages: list[ModelMessage],
) -> None:
    messages_json = await externalize_media(
        json.loads(ModelMessagesTypeAdapter.dump_json(messages)),
        media_store=PgMediaStore(engine),
        threshold_bytes=_MEDIA_THRESHOLD_BYTES,
    )
    async with engine.begin() as conn:
        await conn.execute(
            snapshots_table.insert().values(
                run_id=run_id,
                step_index=step_index,
                conversation_id=conversation_id,
                timestamp=_INLINE_SNAPSHOT_AT,
                state="complete",
                messages=json.dumps(messages_json),
            )
        )


async def raw_snapshot_messages(engine: AsyncEngine) -> list[str]:
    async with engine.connect() as conn:
        rows = await conn.execute(text("SELECT messages FROM agent_runtime.snapshots ORDER BY seq"))
        return [row[0] for row in rows]


async def stored_message_count(engine: AsyncEngine) -> int:
    async with engine.connect() as conn:
        return (
            await conn.execute(text("SELECT count(*) FROM agent_runtime.snapshot_messages"))
        ).scalar_one()


__all__ = [
    "AGENT_RUNTIME_TABLES",
    "APP_TABLES",
    "LOCK_TIMEOUT",
    "connected",
    "insert_inline_snapshot",
    "raw_snapshot_messages",
    "reset_database",
    "stored_message_count",
    "truncate_clean",
]
