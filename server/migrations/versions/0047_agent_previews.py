"""agent 测试预览：运行时会话可以是预览会话，后端记每段预览归谁。

Revision ID: b3841ad11a3d
Revises: b7e2c94d1a3f
Create Date: 2026-11-01 10:00:00.000000

``agent_runtime.sessions`` 加可空的 ``preview_agent_id``，外键指向同一 schema 的 ``agents``：有值就是预览
会话，``agent_version_id`` 为空时每次运行装那个 agent 当下的草稿，否则装那一版。现有会话都是普通会话，
不回填。

``iclip.agent_previews`` 一段预览一行：``id`` 就是运行时的会话 id，记属主、预览的 agent 与版本（为空即草稿）。
两个 schema 之间不加外键，``agent_id`` 与 ``version_id`` 只是记下来的值；属主删掉时预览一起删。

降级删掉这张表与这一列；那时还在的预览会话变回没有版本的普通会话（运行时装不起来），后端也不再认得它们。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b3841ad11a3d"
down_revision: str | None = "b7e2c94d1a3f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

RUNTIME_SCHEMA = "agent_runtime"
APP_SCHEMA = "iclip"


def upgrade() -> None:
    op.add_column(
        "sessions",
        sa.Column("preview_agent_id", sa.Text(), nullable=True),
        schema=RUNTIME_SCHEMA,
    )
    op.create_foreign_key(
        "fk_sessions_preview_agent",
        "sessions",
        "agents",
        ["preview_agent_id"],
        ["id"],
        source_schema=RUNTIME_SCHEMA,
        referent_schema=RUNTIME_SCHEMA,
    )
    op.create_table(
        "agent_previews",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("owner_user_id", sa.Uuid(), nullable=False),
        sa.Column("agent_id", sa.Text(), nullable=False),
        sa.Column("version_id", sa.Uuid(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.ForeignKeyConstraint(
            ["owner_user_id"],
            [f"{APP_SCHEMA}.users.id"],
            name="fk_agent_previews_owner",
            ondelete="cascade",
        ),
        sa.PrimaryKeyConstraint("id"),
        schema=APP_SCHEMA,
    )


def downgrade() -> None:
    op.drop_table("agent_previews", schema=APP_SCHEMA)
    op.drop_constraint(
        "fk_sessions_preview_agent", "sessions", schema=RUNTIME_SCHEMA, type_="foreignkey"
    )
    op.drop_column("sessions", "preview_agent_id", schema=RUNTIME_SCHEMA)
