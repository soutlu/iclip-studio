"""iclip：新表 ``whole_film_drafts``，每段对话一份整片草稿。

Revision ID: a38f28430ec1
Revises: 0f74c2a89d31
Create Date: 2026-10-17 12:00:00.000000

一段对话一行：前端编辑器与渲染服务读写的那份 JSON 文档、版本号（第一次存是 1，每存一次加一）、
最后是谁存的与存的时刻。草稿没有历史版本。
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "a38f28430ec1"
down_revision: str | None = "0f74c2a89d31"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "iclip"
TABLE = "whole_film_drafts"


def upgrade() -> None:
    """建表；约束与 ``conversations.infra_sql.whole_film_drafts_table`` 同名同式。"""

    op.create_table(
        TABLE,
        sa.Column("conversation_id", sa.Uuid(), nullable=False),
        sa.Column("document", postgresql.JSONB(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("updated_by", sa.Uuid(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("revision >= 1", name="ck_whole_film_drafts_revision"),
        sa.CheckConstraint(
            "jsonb_typeof(document) = 'object'", name="ck_whole_film_drafts_document"
        ),
        sa.ForeignKeyConstraint(
            ["conversation_id"],
            [f"{SCHEMA}.conversations.id"],
            name="fk_whole_film_drafts_conversation",
        ),
        sa.ForeignKeyConstraint(
            ["updated_by"], [f"{SCHEMA}.users.id"], name="fk_whole_film_drafts_updated_by"
        ),
        sa.PrimaryKeyConstraint("conversation_id"),
        schema=SCHEMA,
    )


def downgrade() -> None:
    """删表，草稿随之丢弃：旧版本没有整片草稿。"""

    op.drop_table(TABLE, schema=SCHEMA)
