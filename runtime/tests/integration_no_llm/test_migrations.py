from __future__ import annotations

import asyncio
import sys
from typing import Any

import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import Connection, text
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from cue import admin
from cue.harness.sessions import DB_SCHEMA
from cue.migrations.runner import include_name, include_object, target_metadata


def _admin(monkeypatch: pytest.MonkeyPatch, url: str, command: str) -> None:
    monkeypatch.setenv("DATABASE_URL", url)
    monkeypatch.setattr(sys, "argv", ["cue.admin", command])
    admin.main()


async def _execute(url: str, statement: str) -> list[Any]:
    engine = create_async_engine(url, poolclass=NullPool)
    try:
        async with engine.begin() as conn:
            result = await conn.execute(text(statement))
            return list(result) if result.returns_rows else []
    finally:
        await engine.dispose()


def _differences(connection: Connection) -> list[Any]:
    context = MigrationContext.configure(
        connection,
        opts={
            "version_table_schema": DB_SCHEMA,
            "include_schemas": True,
            "include_name": include_name,
            "include_object": include_object,
        },
    )
    return compare_metadata(context, target_metadata())


async def _differences_from_metadata(url: str) -> list[Any]:
    engine = create_async_engine(url, poolclass=NullPool)
    try:
        async with engine.connect() as conn:
            return await conn.run_sync(_differences)
    finally:
        await engine.dispose()


def _revisions(url: str) -> list[str]:
    rows = asyncio.run(_execute(url, "SELECT version_num FROM agent_runtime.alembic_version"))
    return [row.version_num for row in rows]


def _make_unstamped_database(monkeypatch: pytest.MonkeyPatch, url: str) -> None:
    _admin(monkeypatch, url, "migrate")
    asyncio.run(_execute(url, "DROP TABLE agent_runtime.alembic_version"))


def test_migrate_builds_the_structure_the_code_declares(
    scratch_db: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    _admin(monkeypatch, scratch_db, "migrate")

    assert asyncio.run(_differences_from_metadata(scratch_db)) == []


def test_migrate_after_stamp_baseline_changes_nothing(
    scratch_db: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    _make_unstamped_database(monkeypatch, scratch_db)

    _admin(monkeypatch, scratch_db, "stamp-baseline")
    stamped = _revisions(scratch_db)
    _admin(monkeypatch, scratch_db, "migrate")

    assert len(stamped) == 1
    assert _revisions(scratch_db) == stamped
    assert asyncio.run(_differences_from_metadata(scratch_db)) == []


def test_stamp_baseline_refuses_a_database_without_the_tables(
    scratch_db: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    with pytest.raises(SystemExit, match=r"没有 agent_runtime\.sessions"):
        _admin(monkeypatch, scratch_db, "stamp-baseline")

    missing = asyncio.run(_execute(scratch_db, "SELECT to_regnamespace('agent_runtime')"))
    assert missing[0][0] is None


def test_stamp_baseline_refuses_a_stamped_database(
    scratch_db: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    _admin(monkeypatch, scratch_db, "migrate")

    with pytest.raises(SystemExit, match="已经打过基线标记"):
        _admin(monkeypatch, scratch_db, "stamp-baseline")
