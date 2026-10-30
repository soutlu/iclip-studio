"""agent_runtime：运行时会话。新表 ``sessions``，一段对话一行，记它固定用的 agent 版本。

Revision ID: 4d1a8c6e2b90
Revises: 7b2e4d9c1f63
Create Date: 2026-10-30 22:00:00.000000

``id`` 等于对话 id，不加指向 ``iclip.conversations`` 的外键；``agent_version_id`` 可空，外键指向
``iclip.agent_versions``，为空就是这段对话没有可用的版本。现有对话的行由切换命令
``scripts/import_agent_config.py`` 写入，迁移不回填。

降级删掉这张表。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "4d1a8c6e2b90"
down_revision: str | None = "7b2e4d9c1f63"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

RUNTIME_SCHEMA = "agent_runtime"
APP_SCHEMA = "iclip"


def upgrade() -> None:
    op.create_table(
        "sessions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("agent_version_id", sa.Uuid(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.ForeignKeyConstraint(
            ["agent_version_id"],
            [f"{APP_SCHEMA}.agent_versions.id"],
            name="fk_sessions_agent_version",
        ),
        sa.PrimaryKeyConstraint("id"),
        schema=RUNTIME_SCHEMA,
    )


def downgrade() -> None:
    op.drop_table("sessions", schema=RUNTIME_SCHEMA)
