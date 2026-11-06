"""iclip：Agent 配置。新表 ``agents``、``agent_drafts``、``agent_versions``、``agent_revisions``、
``agent_skill_bindings``、``agent_version_skills``。

Revision ID: 7b2e4d9c1f63
Revises: 3c8e5f1a9b27
Create Date: 2026-10-30 18:00:00.000000

``agents`` 一个 agent 一行，``id`` 是标识（文本，创建后不能改）；``active_version_id`` 不加外键，由发布的
事务在同一 agent 的行锁下改。``agent_drafts`` 每个 agent 一份草稿，``config`` 是 jsonb，``lock_version``
是乐观锁。``agent_versions`` 是发布后不再修改的版本，同一 agent 内版本号唯一。``agent_revisions`` 是操作
记录。``agent_skill_bindings`` 与 ``agent_version_skills`` 分别是草稿与各版本的技能名单，``priority`` 是
先后。状态、操作种类与配置格式只在 Python 里检查，不加 CHECK。

降级删掉六张表。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "7b2e4d9c1f63"
down_revision: str | None = "3c8e5f1a9b27"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"


def _timestamp(name: str) -> sa.Column[object]:
    return sa.Column(
        name, sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")
    )


def upgrade() -> None:
    op.create_table(
        "agents",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("listed", sa.Boolean(), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        sa.Column("active_version_id", sa.Uuid(), nullable=True),
        sa.Column("created_by", sa.Uuid(), nullable=False),
        _timestamp("created_at"),
        _timestamp("updated_at"),
        sa.ForeignKeyConstraint(["created_by"], [f"{SCHEMA}.users.id"]),
        sa.PrimaryKeyConstraint("id"),
        schema=SCHEMA,
    )
    op.create_table(
        "agent_drafts",
        sa.Column("agent_id", sa.Text(), nullable=False),
        sa.Column("config", JSONB(), nullable=False),
        sa.Column("base_version_id", sa.Uuid(), nullable=True),
        sa.Column("lock_version", sa.Integer(), nullable=False),
        sa.Column("updated_by", sa.Uuid(), nullable=False),
        _timestamp("updated_at"),
        sa.ForeignKeyConstraint(["agent_id"], [f"{SCHEMA}.agents.id"]),
        sa.ForeignKeyConstraint(["updated_by"], [f"{SCHEMA}.users.id"]),
        sa.PrimaryKeyConstraint("agent_id"),
        schema=SCHEMA,
    )
    op.create_table(
        "agent_versions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("agent_id", sa.Text(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("config", JSONB(), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_by", sa.Uuid(), nullable=False),
        _timestamp("created_at"),
        sa.ForeignKeyConstraint(["agent_id"], [f"{SCHEMA}.agents.id"]),
        sa.ForeignKeyConstraint(["created_by"], [f"{SCHEMA}.users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("agent_id", "version", name="uq_agent_versions_agent_version"),
        schema=SCHEMA,
    )
    op.create_table(
        "agent_revisions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("agent_id", sa.Text(), nullable=False),
        sa.Column("operation", sa.Text(), nullable=False),
        sa.Column("from_version_id", sa.Uuid(), nullable=True),
        sa.Column("to_version_id", sa.Uuid(), nullable=True),
        sa.Column("actor_id", sa.Uuid(), nullable=False),
        _timestamp("created_at"),
        sa.ForeignKeyConstraint(["agent_id"], [f"{SCHEMA}.agents.id"]),
        sa.ForeignKeyConstraint(["actor_id"], [f"{SCHEMA}.users.id"]),
        sa.PrimaryKeyConstraint("id"),
        schema=SCHEMA,
    )
    op.create_table(
        "agent_skill_bindings",
        sa.Column("agent_id", sa.Text(), nullable=False),
        sa.Column("skill_id", sa.Uuid(), nullable=False),
        sa.Column("priority", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["agent_id"], [f"{SCHEMA}.agents.id"]),
        sa.ForeignKeyConstraint(["skill_id"], [f"{SCHEMA}.skills.id"]),
        sa.PrimaryKeyConstraint("agent_id", "skill_id"),
        schema=SCHEMA,
    )
    op.create_table(
        "agent_version_skills",
        sa.Column("version_id", sa.Uuid(), nullable=False),
        sa.Column("skill_id", sa.Uuid(), nullable=False),
        sa.Column("priority", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["version_id"], [f"{SCHEMA}.agent_versions.id"]),
        sa.ForeignKeyConstraint(["skill_id"], [f"{SCHEMA}.skills.id"]),
        sa.PrimaryKeyConstraint("version_id", "skill_id"),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_table("agent_version_skills", schema=SCHEMA)
    op.drop_table("agent_skill_bindings", schema=SCHEMA)
    op.drop_table("agent_revisions", schema=SCHEMA)
    op.drop_table("agent_versions", schema=SCHEMA)
    op.drop_table("agent_drafts", schema=SCHEMA)
    op.drop_table("agents", schema=SCHEMA)
