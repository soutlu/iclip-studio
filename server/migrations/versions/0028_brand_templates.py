"""iclip：新表 ``brand_templates``，管理员在资料库维护的片头、片尾视频。

Revision ID: 476ee9b3b464
Revises: 3c8e5a1f9d40
Create Date: 2026-10-14 22:00:00.000000

每行一条模板：位置（片头或片尾）、名称、视频地址（取自一条视频上传），以及建模板时从视频量出来的
画幅、时长与有没有音轨；记创建人与 API key，停用时刻为空表示在用，不硬删。

整片的请求里记的是模板的快照，生成记录对这张表没有外键，降级直接删表。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "476ee9b3b464"
down_revision: str | None = "3c8e5a1f9d40"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"
TABLE = "brand_templates"


def upgrade() -> None:
    op.create_table(
        TABLE,
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("position", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("video_url", sa.Text(), nullable=False),
        sa.Column("width", sa.Integer(), nullable=False),
        sa.Column("height", sa.Integer(), nullable=False),
        sa.Column("duration_ms", sa.Integer(), nullable=False),
        sa.Column("has_audio", sa.Boolean(), nullable=False),
        sa.Column("created_by", sa.Uuid(), nullable=False),
        sa.Column("api_key_id", sa.Uuid(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("disabled_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("position IN ('intro', 'outro')", name="ck_brand_templates_position"),
        sa.CheckConstraint("btrim(name) <> ''", name="ck_brand_templates_name"),
        sa.CheckConstraint("width > 0 AND height > 0", name="ck_brand_templates_size"),
        sa.CheckConstraint("duration_ms > 0", name="ck_brand_templates_duration"),
        sa.ForeignKeyConstraint(
            ["created_by"], [f"{SCHEMA}.users.id"], name="fk_brand_templates_created_by"
        ),
        sa.PrimaryKeyConstraint("id"),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_table(TABLE, schema=SCHEMA)
