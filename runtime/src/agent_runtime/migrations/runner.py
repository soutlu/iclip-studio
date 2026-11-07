from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from alembic import command
from alembic.config import Config
from alembic.runtime.environment import NameFilterParentNames, NameFilterType
from alembic.script import ScriptDirectory
from sqlalchemy import MetaData, text
from sqlalchemy.ext.asyncio import create_async_engine

from agent_runtime.config.agent_config.public import metadata_obj as agent_config_metadata
from agent_runtime.config.mcp_servers.public import metadata_obj as mcp_servers_metadata
from agent_runtime.config.model_providers.public import metadata_obj as model_providers_metadata
from agent_runtime.config.skills.public import metadata_obj as skills_metadata
from agent_runtime.file_store.pg import metadata_obj as file_store_metadata
from agent_runtime.harness.jobs import metadata_obj as jobs_metadata
from agent_runtime.harness.sessions import DB_SCHEMA
from agent_runtime.harness.sessions import metadata_obj as sessions_metadata
from agent_runtime.harness.step_store_pg import metadata_obj as step_store_metadata
from agent_runtime.harness.usage_ledger_pg import metadata_obj as usage_ledger_metadata

_MODULE_METADATA = (
    skills_metadata,
    model_providers_metadata,
    mcp_servers_metadata,
    agent_config_metadata,
    step_store_metadata,
    jobs_metadata,
    sessions_metadata,
    usage_ledger_metadata,
    file_store_metadata,
)

# sessions 与 agent 配置在两份 metadata 里，这两条外键只存在于迁移。
_FOREIGN_KEYS_ONLY_IN_MIGRATIONS = frozenset(
    {"fk_sessions_agent_version", "fk_sessions_preview_agent"}
)

_PROBE_TABLES = text(
    f"SELECT to_regclass('{DB_SCHEMA}.sessions') IS NOT NULL,"
    f" to_regclass('{DB_SCHEMA}.alembic_version') IS NOT NULL"
)
_STAMPED_REVISIONS = text(f"SELECT count(*) FROM {DB_SCHEMA}.alembic_version")


class BaselineStampRefused(Exception):
    """这个库不该打基线标记：没有运行时的表，或者已经打过。"""


def target_metadata() -> MetaData:
    """各模块的表并到一份 metadata：跨模块的外键要在同一份里才解析得到。"""

    merged = MetaData()
    for metadata in _MODULE_METADATA:
        for table in metadata.tables.values():
            table.to_metadata(merged)
    return merged


def include_name(
    name: str | None, type_: NameFilterType, parent_names: NameFilterParentNames
) -> bool:
    return type_ != "schema" or name == DB_SCHEMA


def include_object(
    obj: Any, name: str | None, type_: str, reflected: bool, compare_to: Any
) -> bool:
    return not (type_ == "foreign_key_constraint" and name in _FOREIGN_KEYS_ONLY_IN_MIGRATIONS)


def upgrade(database_url: str) -> None:
    """把 `agent_runtime` schema 升到最新；不能在运行中的事件循环里调用。"""

    command.upgrade(_config(database_url), "head")


def stamp_baseline(database_url: str) -> None:
    """给已有运行时表的库打基线标记，不动表结构；基线之后的迁移留给 `upgrade`。

    Raises:
        BaselineStampRefused: 库里没有运行时的表，或者已经打过标记。
    """

    tables_exist, stamped = asyncio.run(_probe(database_url))
    if not tables_exist:
        raise BaselineStampRefused(f"库里没有 {DB_SCHEMA}.sessions，新库直接执行 migrate")
    if stamped:
        raise BaselineStampRefused(f"{DB_SCHEMA} 已经打过基线标记，直接执行 migrate")
    config = _config(database_url)
    baseline = ScriptDirectory.from_config(config).get_base()
    if baseline is None:
        raise RuntimeError("迁移目录里没有基线")
    command.stamp(config, baseline)


async def _probe(database_url: str) -> tuple[bool, bool]:
    engine = create_async_engine(database_url)
    try:
        async with engine.connect() as conn:
            tables_exist, versions_exist = (await conn.execute(_PROBE_TABLES)).one()
            stamped = versions_exist and (await conn.execute(_STAMPED_REVISIONS)).scalar_one() > 0
    finally:
        await engine.dispose()
    return tables_exist, stamped


def _config(database_url: str) -> Config:
    config = Config()
    config.set_main_option("script_location", str(Path(__file__).parent))
    config.attributes["sqlalchemy_url"] = database_url
    return config


__all__ = [
    "BaselineStampRefused",
    "include_name",
    "include_object",
    "stamp_baseline",
    "target_metadata",
    "upgrade",
]
