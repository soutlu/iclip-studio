"""agent_runtime：技能库、模型供应商与 agent 配置的十四张表从 ``iclip`` 挪进 ``agent_runtime``，去掉指向
``iclip.users`` 的八个外键。

Revision ID: 62893acbf136
Revises: fd5fe51c6ffc
Create Date: 2026-10-30 23:50:00.000000

这几张表归运行时，操作人列（``created_by``、``updated_by``、``actor_id``）留作普通 uuid，记应用给的用户
id，运行时不核对。``SET SCHEMA`` 只改表所在的 schema，行、主键、唯一约束、索引与表之间的外键（名字与
``ON DELETE`` 不变）都跟着走；``agent_runtime.sessions`` 指向 ``agent_versions`` 的外键随之变成同一
schema 内的。这些表没有枚举类型、序列或视图要一起挪。

降级把表挪回 ``iclip`` 并按原名补回八个外键；有操作人 id 在 ``iclip.users`` 里找不到时先报错停下，什么都
不改。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "62893acbf136"
down_revision: str | None = "fd5fe51c6ffc"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

APP_SCHEMA = "iclip"
RUNTIME_SCHEMA = "agent_runtime"

TABLES = (
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

USER_FOREIGN_KEYS = (
    ("skills", "created_by", "skills_created_by_fkey"),
    ("skill_draft_files", "updated_by", "skill_draft_files_updated_by_fkey"),
    ("skill_versions", "created_by", "skill_versions_created_by_fkey"),
    ("provider_credentials", "created_by", "provider_credentials_created_by_fkey"),
    ("agents", "created_by", "agents_created_by_fkey"),
    ("agent_drafts", "updated_by", "agent_drafts_updated_by_fkey"),
    ("agent_versions", "created_by", "agent_versions_created_by_fkey"),
    ("agent_revisions", "actor_id", "agent_revisions_actor_id_fkey"),
)
"""（表，操作人列，0040–0042 建表时 Postgres 起的外键名）。"""


def _move(source: str, target: str) -> None:
    for table in TABLES:
        op.execute(f"ALTER TABLE {source}.{table} SET SCHEMA {target}")


def upgrade() -> None:
    for table, _column, name in USER_FOREIGN_KEYS:
        op.drop_constraint(name, table, schema=APP_SCHEMA, type_="foreignkey")
    _move(APP_SCHEMA, RUNTIME_SCHEMA)


def _orphans() -> list[str]:
    connection = op.get_bind()
    found = []
    for table, column, _name in USER_FOREIGN_KEYS:
        count = connection.execute(
            sa.text(
                f"SELECT count(*) FROM {RUNTIME_SCHEMA}.{table} t"
                f" WHERE NOT EXISTS (SELECT 1 FROM {APP_SCHEMA}.users u WHERE u.id = t.{column})"
            )
        ).scalar_one()
        if count:
            found.append(f"{table}.{column} {count} 行")
    return found


def downgrade() -> None:
    orphans = _orphans()
    if orphans:
        raise RuntimeError(
            "降级停下，什么都没改：这些行的操作人 id 在 iclip.users 里找不到，补不回外键："
            + "；".join(orphans)
        )
    _move(RUNTIME_SCHEMA, APP_SCHEMA)
    for table, column, name in USER_FOREIGN_KEYS:
        op.create_foreign_key(
            name,
            table,
            "users",
            [column],
            ["id"],
            source_schema=APP_SCHEMA,
            referent_schema=APP_SCHEMA,
        )
