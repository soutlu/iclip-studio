"""iclip：技能库。新表 ``skills``、``skill_draft_files``、``skill_versions``、``skill_version_files``。

Revision ID: 3d9f6b2a8c51
Revises: e7b3c91d4a26
Create Date: 2026-10-30 12:00:00.000000

``skills`` 一个技能一行，``name`` 是创建后不改的标识；``skill_draft_files`` 是它的草稿，一个文件一行，
记 UTF-8 字节数与内容的 sha256；``skill_versions`` 是发布一次生成的版本，同一技能内版本号唯一，
``manifest`` 是按路径排好的 ``[{path, size, hash}]``，``content_hash`` 建普通索引；
``skill_version_files`` 是版本的文件，发布后不再修改。``latest_version_id`` 不加外键，状态与文件规则
只在 Python 里，不加 CHECK。没有存量数据要搬。

降级删掉四张表。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "3d9f6b2a8c51"
down_revision: str | None = "e7b3c91d4a26"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"


def _now(name: str) -> sa.Column[sa.DateTime]:
    return sa.Column(
        name, sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")
    )


def upgrade() -> None:
    op.create_table(
        "skills",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("display_name", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("latest_version_id", sa.Uuid(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("created_by", sa.Uuid(), nullable=False),
        _now("created_at"),
        _now("updated_at"),
        sa.ForeignKeyConstraint(["created_by"], [f"{SCHEMA}.users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name", name="uq_skills_name"),
        schema=SCHEMA,
    )
    op.create_table(
        "skill_draft_files",
        sa.Column("skill_id", sa.Uuid(), nullable=False),
        sa.Column("path", sa.Text(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("size", sa.Integer(), nullable=False),
        sa.Column("hash", sa.Text(), nullable=False),
        sa.Column("updated_by", sa.Uuid(), nullable=False),
        _now("updated_at"),
        sa.ForeignKeyConstraint(["skill_id"], [f"{SCHEMA}.skills.id"]),
        sa.ForeignKeyConstraint(["updated_by"], [f"{SCHEMA}.users.id"]),
        sa.PrimaryKeyConstraint("skill_id", "path"),
        schema=SCHEMA,
    )
    op.create_table(
        "skill_versions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("skill_id", sa.Uuid(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("manifest", JSONB(), nullable=False),
        sa.Column("content_hash", sa.Text(), nullable=False),
        sa.Column("created_by", sa.Uuid(), nullable=False),
        _now("created_at"),
        sa.ForeignKeyConstraint(["skill_id"], [f"{SCHEMA}.skills.id"]),
        sa.ForeignKeyConstraint(["created_by"], [f"{SCHEMA}.users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("skill_id", "version", name="uq_skill_versions_skill_version"),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_skill_versions_content_hash", "skill_versions", ["content_hash"], schema=SCHEMA
    )
    op.create_table(
        "skill_version_files",
        sa.Column("version_id", sa.Uuid(), nullable=False),
        sa.Column("path", sa.Text(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.ForeignKeyConstraint(["version_id"], [f"{SCHEMA}.skill_versions.id"]),
        sa.PrimaryKeyConstraint("version_id", "path"),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_table("skill_version_files", schema=SCHEMA)
    op.drop_table("skill_versions", schema=SCHEMA)
    op.drop_table("skill_draft_files", schema=SCHEMA)
    op.drop_table("skills", schema=SCHEMA)
