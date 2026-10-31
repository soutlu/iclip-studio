"""技能库、模型供应商与 agent 配置的表挪进 ``agent_runtime`` 的迁移：行原样跟过去，表之间的外键名字与
``ON DELETE`` 不变，指向用户表的外键去掉。

升级在一次性库上做，不动会话共用的测试库。"""

from __future__ import annotations

import asyncio
import uuid
from typing import Any

import pytest
from alembic import command
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.pool import NullPool

from iclip.platform.db.engine import build_engine
from tests.helpers.migrations import alembic_config

BEFORE = "fd5fe51c6ffc"
"""0044，配置的表还在 ``iclip``，操作人列有指向 ``iclip.users`` 的外键。"""

AFTER = "62893acbf136"
"""0045，配置的表在 ``agent_runtime``。"""

MOVED = (
    "skills",
    "skill_draft_files",
    "skill_versions",
    "skill_version_files",
    "model_providers",
    "provider_credentials",
    "provider_models",
    "default_models",
    "agents",
    "agent_drafts",
    "agent_versions",
    "agent_revisions",
    "agent_skill_bindings",
    "agent_version_skills",
)

SKILL = uuid.UUID("00000000-0000-0000-0000-0000000000a1")
SKILL_VERSION = uuid.UUID("00000000-0000-0000-0000-0000000000a2")
PROVIDER = uuid.UUID("00000000-0000-0000-0000-0000000000b1")
CREDENTIAL = uuid.UUID("00000000-0000-0000-0000-0000000000b2")
PROVIDER_MODEL = uuid.UUID("00000000-0000-0000-0000-0000000000b3")
AGENT = "director"
AGENT_VERSION = uuid.UUID("00000000-0000-0000-0000-0000000000c1")
REVISION = uuid.UUID("00000000-0000-0000-0000-0000000000c2")
SESSION = uuid.UUID("00000000-0000-0000-0000-0000000000d1")

FOREIGN_KEYS_AFTER = {
    ("skill_draft_files", "skill_draft_files_skill_id_fkey"): (
        "FOREIGN KEY (skill_id) REFERENCES agent_runtime.skills(id)"
    ),
    ("skill_versions", "skill_versions_skill_id_fkey"): (
        "FOREIGN KEY (skill_id) REFERENCES agent_runtime.skills(id)"
    ),
    ("skill_version_files", "skill_version_files_version_id_fkey"): (
        "FOREIGN KEY (version_id) REFERENCES agent_runtime.skill_versions(id)"
    ),
    ("provider_credentials", "provider_credentials_provider_id_fkey"): (
        "FOREIGN KEY (provider_id) REFERENCES agent_runtime.model_providers(id) ON DELETE CASCADE"
    ),
    ("provider_models", "provider_models_provider_id_fkey"): (
        "FOREIGN KEY (provider_id) REFERENCES agent_runtime.model_providers(id) ON DELETE CASCADE"
    ),
    ("default_models", "default_models_provider_id_fkey"): (
        "FOREIGN KEY (provider_id) REFERENCES agent_runtime.model_providers(id)"
    ),
    ("agent_drafts", "agent_drafts_agent_id_fkey"): (
        "FOREIGN KEY (agent_id) REFERENCES agent_runtime.agents(id)"
    ),
    ("agent_versions", "agent_versions_agent_id_fkey"): (
        "FOREIGN KEY (agent_id) REFERENCES agent_runtime.agents(id)"
    ),
    ("agent_revisions", "agent_revisions_agent_id_fkey"): (
        "FOREIGN KEY (agent_id) REFERENCES agent_runtime.agents(id)"
    ),
    ("agent_skill_bindings", "agent_skill_bindings_agent_id_fkey"): (
        "FOREIGN KEY (agent_id) REFERENCES agent_runtime.agents(id)"
    ),
    ("agent_skill_bindings", "agent_skill_bindings_skill_id_fkey"): (
        "FOREIGN KEY (skill_id) REFERENCES agent_runtime.skills(id)"
    ),
    ("agent_version_skills", "agent_version_skills_version_id_fkey"): (
        "FOREIGN KEY (version_id) REFERENCES agent_runtime.agent_versions(id)"
    ),
    ("agent_version_skills", "agent_version_skills_skill_id_fkey"): (
        "FOREIGN KEY (skill_id) REFERENCES agent_runtime.skills(id)"
    ),
    ("sessions", "fk_sessions_agent_version"): (
        "FOREIGN KEY (agent_version_id) REFERENCES agent_runtime.agent_versions(id)"
    ),
}
"""升级后 ``agent_runtime`` 里这些表的全部外键：表之间的照旧，``sessions`` 的变成同一 schema 内的，
没有一个指向 ``iclip``。"""

_CONSTRAINTS = text(
    "SELECT n.nspname, c.relname, con.conname, pg_get_constraintdef(con.oid)"
    " FROM pg_constraint con"
    " JOIN pg_class c ON c.oid = con.conrelid"
    " JOIN pg_namespace n ON n.oid = c.relnamespace"
    " WHERE n.nspname IN ('iclip', 'agent_runtime') AND c.relname = ANY(:tables)"
)

_SCHEMA_OF = text(
    "SELECT tablename, schemaname FROM pg_tables"
    " WHERE schemaname IN ('iclip', 'agent_runtime') AND tablename = ANY(:tables)"
)


async def _fetch(url: str, statement: Any, params: dict[str, Any] | None = None) -> list[Any]:
    engine = build_engine(url, poolclass=NullPool)
    try:
        async with engine.connect() as conn:
            return list((await conn.execute(statement, params or {})).all())
    finally:
        await engine.dispose()


async def _execute(url: str, *statements: tuple[str, dict[str, Any]]) -> None:
    engine = build_engine(url, poolclass=NullPool)
    try:
        async with engine.begin() as conn:
            for statement, params in statements:
                await conn.execute(text(statement), params)
    finally:
        await engine.dispose()


def _plant_user(url: str) -> uuid.UUID:
    user = uuid.uuid4()
    asyncio.run(
        _execute(
            url,
            (
                "INSERT INTO iclip.users (id, email, hashed_password, is_active, is_superuser,"
                " is_verified, display_name, avatar_url, roles, direct_permissions, city,"
                " job_title, departments)"
                " VALUES (:id, :email, '', true, false, true, 'root', '', '[]', '[]', '', '',"
                " '[]')",
                {"id": user, "email": f"{user}@example.com"},
            ),
        )
    )
    return user


def _seed(url: str, schema: str, actor: uuid.UUID) -> None:
    """``schema`` 里每张配置表一行，操作人都是 ``actor``；再开一个指向这个 agent 版本的会话。"""

    s = schema
    asyncio.run(
        _execute(
            url,
            (
                f"INSERT INTO {s}.skills (id, name, display_name, description, status, created_by)"
                " VALUES (:id, 'guide', '指南', '', 'active', :actor)",
                {"id": SKILL, "actor": actor},
            ),
            (
                f"INSERT INTO {s}.skill_draft_files (skill_id, path, content, size, hash,"
                " updated_by) VALUES (:skill, 'SKILL.md', 'x', 1, 'h', :actor)",
                {"skill": SKILL, "actor": actor},
            ),
            (
                f"INSERT INTO {s}.skill_versions (id, skill_id, version, manifest, content_hash,"
                " created_by) VALUES (:id, :skill, 1, '[]', 'h', :actor)",
                {"id": SKILL_VERSION, "skill": SKILL, "actor": actor},
            ),
            (
                f"INSERT INTO {s}.skill_version_files (version_id, path, content)"
                " VALUES (:version, 'SKILL.md', 'x')",
                {"version": SKILL_VERSION},
            ),
            (
                f"INSERT INTO {s}.model_providers (id, name, provider, label)"
                " VALUES (:id, 'bailian', 'bailian', '百炼')",
                {"id": PROVIDER},
            ),
            (
                f"INSERT INTO {s}.provider_credentials (id, provider_id, name, fields, created_by)"
                " VALUES (:id, :provider, 'key', '{}', :actor)",
                {"id": CREDENTIAL, "provider": PROVIDER, "actor": actor},
            ),
            (
                f"INSERT INTO {s}.provider_models (id, provider_id, name, type, source, enabled)"
                " VALUES (:id, :provider, 'qwen', 'llm', 'custom', true)",
                {"id": PROVIDER_MODEL, "provider": PROVIDER},
            ),
            (
                f"INSERT INTO {s}.default_models (type, provider_id, model_name)"
                " VALUES ('llm', :provider, 'qwen')",
                {"provider": PROVIDER},
            ),
            (
                f"INSERT INTO {s}.agents (id, name, description, status, listed, sort_order,"
                " created_by) VALUES (:id, 'AI 导演', '', 'active', true, 0, :actor)",
                {"id": AGENT, "actor": actor},
            ),
            (
                f"INSERT INTO {s}.agent_drafts (agent_id, config, lock_version, updated_by)"
                " VALUES (:agent, '{}', 1, :actor)",
                {"agent": AGENT, "actor": actor},
            ),
            (
                f"INSERT INTO {s}.agent_versions (id, agent_id, version, config, created_by)"
                " VALUES (:id, :agent, 1, '{}', :actor)",
                {"id": AGENT_VERSION, "agent": AGENT, "actor": actor},
            ),
            (
                f"INSERT INTO {s}.agent_revisions (id, agent_id, operation, actor_id)"
                " VALUES (:id, :agent, 'publish', :actor)",
                {"id": REVISION, "agent": AGENT, "actor": actor},
            ),
            (
                f"INSERT INTO {s}.agent_skill_bindings (agent_id, skill_id, priority)"
                " VALUES (:agent, :skill, 0)",
                {"agent": AGENT, "skill": SKILL},
            ),
            (
                f"INSERT INTO {s}.agent_version_skills (version_id, skill_id, priority)"
                " VALUES (:version, :skill, 0)",
                {"version": AGENT_VERSION, "skill": SKILL},
            ),
            (
                "INSERT INTO agent_runtime.sessions (id, app_id, agent_version_id)"
                " VALUES (:id, 'video', :version)",
                {"id": SESSION, "version": AGENT_VERSION},
            ),
        )
    )


def _rows(url: str, schema: str) -> dict[str, list[str]]:
    """每张配置表的全部行，整行转成 JSON 文本比。"""

    return {
        table: sorted(
            row[0]
            for row in asyncio.run(
                _fetch(url, text(f"SELECT to_jsonb(t)::text FROM {schema}.{table} t"))
            )
        )
        for table in MOVED
    }


def _schemas(url: str) -> dict[str, str]:
    return dict(asyncio.run(_fetch(url, _SCHEMA_OF, {"tables": list(MOVED)})))


def _foreign_keys_in_runtime(url: str) -> dict[tuple[str, str], str]:
    constraints = asyncio.run(_fetch(url, _CONSTRAINTS, {"tables": [*MOVED, "sessions"]}))
    return {
        (table, name): definition
        for schema, table, name, definition in constraints
        if schema == "agent_runtime" and definition.startswith("FOREIGN KEY")
    }


def test_upgrade_moves_the_tables_with_their_rows_and_keeps_their_keys(scratch_db: str) -> None:
    cfg = alembic_config(scratch_db)
    command.upgrade(cfg, BEFORE)
    _seed(scratch_db, "iclip", _plant_user(scratch_db))
    rows_before = _rows(scratch_db, "iclip")

    command.upgrade(cfg, AFTER)

    assert _schemas(scratch_db) == dict.fromkeys(MOVED, "agent_runtime")
    assert _rows(scratch_db, "agent_runtime") == rows_before
    assert _foreign_keys_in_runtime(scratch_db) == FOREIGN_KEYS_AFTER


def test_after_upgrade_actors_are_opaque_and_sessions_still_need_a_real_version(
    scratch_db: str,
) -> None:
    cfg = alembic_config(scratch_db)
    command.upgrade(cfg, AFTER)

    _seed(scratch_db, "agent_runtime", uuid.uuid4())

    with pytest.raises(IntegrityError):
        asyncio.run(
            _execute(
                scratch_db,
                (
                    "INSERT INTO agent_runtime.sessions (id, app_id, agent_version_id)"
                    " VALUES (:id, 'video', :version)",
                    {"id": uuid.uuid4(), "version": uuid.uuid4()},
                ),
            )
        )
