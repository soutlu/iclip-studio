from __future__ import annotations

from typing import Any

from sqlalchemy import Column, MetaData, inspect, text

from iclip.domains.brand_templates.infra_sql import metadata_obj as brand_templates_metadata
from iclip.domains.collections.infra_sql import metadata_obj as collections_metadata
from iclip.domains.conversations.infra_sql import metadata_obj as conversations_metadata
from iclip.domains.generation.infra_sql import generation_jobs_table
from iclip.domains.generation.infra_sql import metadata_obj as generation_metadata
from iclip.domains.identity.infra_sql import DB_SCHEMA, Base
from iclip.domains.inspirations.infra_sql import metadata_obj as inspirations_metadata
from iclip.domains.references.infra_sql import metadata_obj as references_metadata
from iclip.domains.tagging.infra_sql import metadata_obj as tagging_metadata
from iclip.domains.tasks.infra_sql import metadata_obj as tasks_metadata
from iclip.domains.tracking.infra_sql import metadata_obj as tracking_metadata
from iclip.platform.db.engine import build_engine

_MODULE_METADATA: tuple[MetaData, ...] = (
    Base.metadata,
    conversations_metadata,
    generation_metadata,
    collections_metadata,
    tasks_metadata,
    inspirations_metadata,
    tracking_metadata,
    references_metadata,
    tagging_metadata,
    brand_templates_metadata,
)


def _columns_in_db(sync_conn: Any) -> dict[str, set[str]]:
    inspector = inspect(sync_conn)
    return {
        f"{DB_SCHEMA}.{table}": {
            column["name"] for column in inspector.get_columns(table, schema=DB_SCHEMA)
        }
        for table in inspector.get_table_names(schema=DB_SCHEMA)
        if table != "alembic_version"
    }


async def test_alembic_head_matches_orm_metadata(migrated_pg: str) -> None:
    engine = build_engine(migrated_pg)
    try:
        async with engine.connect() as conn:
            actual = await conn.run_sync(_columns_in_db)
    finally:
        await engine.dispose()

    expected = {
        table.fullname: {column.name for column in table.columns}
        for metadata in _MODULE_METADATA
        for table in metadata.tables.values()
    }
    assert actual == expected


_INDEXES = text(
    "SELECT c.relname, am.amname,"
    " ARRAY(SELECT pg_get_indexdef(i.indexrelid, k, true)"
    "       FROM generate_series(1, i.indnatts) AS k ORDER BY k),"
    " pg_get_expr(i.indpred, i.indrelid, true)"
    " FROM pg_index i"
    " JOIN pg_class c ON c.oid = i.indexrelid"
    " JOIN pg_am am ON am.oid = c.relam"
    " WHERE i.indrelid = 'iclip.generation_jobs'::regclass AND NOT i.indisprimary"
)


def _generation_jobs_in_db(sync_conn: Any) -> dict[str, Any]:
    inspector = inspect(sync_conn)
    table = generation_jobs_table.name
    return {
        "columns": {
            column["name"]: column["nullable"]
            for column in inspector.get_columns(table, schema=DB_SCHEMA)
        },
        "primary_key": inspector.get_pk_constraint(table, schema=DB_SCHEMA)["constrained_columns"],
        "foreign_keys": {
            fk["name"]: (
                tuple(fk["constrained_columns"]),
                tuple(
                    f"{fk['referred_schema']}.{fk['referred_table']}.{column}"
                    for column in fk["referred_columns"]
                ),
            )
            for fk in inspector.get_foreign_keys(table, schema=DB_SCHEMA)
        },
        "indexes": {
            name: (method, tuple(keys), predicate)
            for name, method, keys, predicate in sync_conn.execute(_INDEXES)
        },
    }


def _generation_jobs_declared() -> dict[str, Any]:
    table = generation_jobs_table
    return {
        "columns": {column.name: column.nullable for column in table.columns},
        "primary_key": [column.name for column in table.primary_key.columns],
        "foreign_keys": {
            fk.name: (
                tuple(column.name for column in fk.columns),
                tuple(element.target_fullname for element in fk.elements),
            )
            for fk in table.foreign_key_constraints
        },
        "indexes": {
            index.name: (
                index.dialect_options["postgresql"]["using"] or "btree",
                tuple(
                    expression.name if isinstance(expression, Column) else str(expression)
                    for expression in index.expressions
                ),
                None
                if index.dialect_options["postgresql"]["where"] is None
                else str(index.dialect_options["postgresql"]["where"]),
            )
            for index in table.indexes
        },
    }


async def test_generation_jobs_matches_its_table_definition(migrated_pg: str) -> None:
    engine = build_engine(migrated_pg)
    try:
        async with engine.connect() as conn:
            actual = await conn.run_sync(_generation_jobs_in_db)
    finally:
        await engine.dispose()

    assert actual == _generation_jobs_declared()
