"""iclip：新表 ``reference_videos``，资料库上传与 AI 导演对话里拆解的视频，一条视频一行。

Revision ID: 21c3a0de53ab
Revises: 602b9cec091d
Create Date: 2026-10-07 12:00:00.000000

每行按地址认一条视频：属主（上传的人或第一次拆它的人）、两组标签（片子类型与品类，可多个，空即
未标注）、拆解状态与最近一次的失败原因、唯一一份当前拆解与它的版本号、最近一次拆解是谁要的、开始
时刻（判超时）与移除标记（ADR-0014）。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "21c3a0de53ab"
down_revision: str | None = "602b9cec091d"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"
TABLE = "reference_videos"


def upgrade() -> None:
    op.create_table(
        TABLE,
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("video_url", sa.Text(), nullable=False),
        sa.Column("owner_user_id", sa.Uuid(), nullable=False),
        sa.Column(
            "video_types",
            postgresql.ARRAY(sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'"),
        ),
        sa.Column(
            "categories",
            postgresql.ARRAY(sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'"),
        ),
        sa.Column("breakdown_status", sa.Text(), nullable=False),
        sa.Column("error_code", sa.Text(), nullable=True),
        sa.Column("document", sa.Text(), nullable=True),
        sa.Column("version", sa.Integer(), nullable=False, server_default=sa.text("1")),
        sa.Column("requested_by", sa.Uuid(), nullable=True),
        sa.Column("api_key_id", sa.Uuid(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "breakdown_status IN ('pending', 'running', 'completed', 'failed')",
            name="ck_reference_videos_status",
        ),
        sa.CheckConstraint(
            "error_code IN ('video_unreadable', 'model_call_failed', 'model_failed', 'timeout')",
            name="ck_reference_videos_error_code",
        ),
        sa.ForeignKeyConstraint(
            ["owner_user_id"], [f"{SCHEMA}.users.id"], name="fk_reference_videos_owner"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("video_url", name="uq_reference_videos_video_url"),
        schema=SCHEMA,
    )
    op.create_index(
        "ix_reference_videos_listed",
        TABLE,
        [sa.text("created_at DESC"), "id"],
        schema=SCHEMA,
        postgresql_where=sa.text("deleted_at IS NULL"),
    )
    op.create_index(
        "ix_reference_videos_video_types",
        TABLE,
        ["video_types"],
        schema=SCHEMA,
        postgresql_using="gin",
    )
    op.create_index(
        "ix_reference_videos_categories",
        TABLE,
        ["categories"],
        schema=SCHEMA,
        postgresql_using="gin",
    )


def downgrade() -> None:
    op.drop_table(TABLE, schema=SCHEMA)
